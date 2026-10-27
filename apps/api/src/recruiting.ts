import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import type { AdapterContext, ArtifactStore, ConnectorProvider } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { McpOAuthBroker } from "@rakazo/adapters";
import {
  classifyInstantlyReplyReceipt,
  createRecruitingCandidateReportReader,
  hasPlatformMcpCredential,
  htmlToPlainText,
  isRecruitingCandidateReportField,
  lastUsedMailbox,
  readActorArtifact,
  readInstantlyEmail,
} from "@rakazo/adapters";
import type {
  Actor,
  ListRecruitingCandidatesOutput,
  ReadRecruitingSourceInput,
  RecruitingAssessmentSourceRef,
  RecruitingCandidateSource,
  RecruitingCorrespondence,
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmRoleReference,
  RecruitingCrmTarget,
  RecruitingRoleCampaign,
  RecruitingRoleCandidate,
  RecruitingRoleCandidatesOutput,
  RecruitingRoleSetup,
  RecruitingSourceRef,
  RecruitingSourceSelection,
} from "@rakazo/contracts";
import {
  RecruitingCorrespondenceSchema,
  RecruitingCrmCampaignLeadsReadSchema,
  RecruitingCrmCampaignsReadSchema,
  RecruitingCrmCandidatesReadSchema,
  RecruitingCrmClientsReadSchema,
  RecruitingCrmDataInputSchema,
  RecruitingCrmDataOutputSchema,
  RecruitingCrmDetailsReadSchema,
  RecruitingCrmImportantReadSchema,
  RecruitingCrmImportReceiptSchema,
  RecruitingCrmMailReadSchema,
  RecruitingCrmMembershipRowsSchema,
  RecruitingCrmMessagesReadSchema,
  RecruitingCrmPersonLeadsReadSchema,
  RecruitingCrmPresenceReadSchema,
  RecruitingCrmRoleCampaignsReadSchema,
  RecruitingCrmRoleMailReadSchema,
  RecruitingCrmRoleReadSchema,
  RecruitingCrmRoleReferenceSchema,
  RecruitingCrmUnassignedReadSchema,
  RecruitingNativeCorrespondenceSchema,
} from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  INSTANTLY_MCP_ENDPOINT,
  isRecruitingPlaybookStage,
  pendingInputAttention,
  type RecruitingPlaybookStage,
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  recruitingCalibrationIdentity,
  recruitingPlaybookStageLabels,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type { PrismaClient, RecruitingRoleMaterialContext, ThreadEvents } from "@rakazo/db";
import * as recruiting from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ParseError } from "jsonc-parser";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import { campaignObservedDetails } from "./recruiting-campaign-details.js";
import type { ThreadTarget } from "./thread-target.js";

async function authenticated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IsolationError) {
      // The caller only sees "not found"; keep which check refused it.
      getLogger().warn("recruiting.not_found", {
        error: error.name,
        at: error.stack?.split("\n")[1]?.trim(),
      });
      throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
    }
    if (error instanceof RecruitingConflictError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof RecruitingPlaybookValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof RecruitingSourceValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof Error && error.name === "ZodError")
      throw new ORPCError("BAD_REQUEST", { message: "Invalid recruiting input" });
    throw error;
  }
}

type RecruitingReadDeps = { prisma: PrismaClient; artifacts: ArtifactStore };

/** Wake the native durable stream only after the mutation has committed. */
export async function notifyRecruitingChange(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  actor: Actor,
  threadId: string,
) {
  try {
    const event = await deps.prisma.event.findFirst({
      where: {
        spaceId: actor.spaceId,
        threadId,
        type: "recruiting.changed",
        thread: { userId: actor.userId, spaceId: actor.spaceId },
      },
      select: { seq: true },
      orderBy: { seq: "desc" },
    });
    if (event) await deps.events.notify(threadId, event.seq);
  } catch (error) {
    // The save committed; native stream catch-up still replays a missed wake-up.
    getLogger().error("recruiting.change.notification.failed", error);
  }
}

// Local REST reads ride the official server's list_emails/get_email assignment (see mcp-connector).
const NATIVE_INSTANTLY_READS = [
  "native_instantly_get_thread_history",
  "native_instantly_search_contact_emails",
  "native_instantly_list_mailbox_emails",
  "native_instantly_get_email",
];
const isNativeInstantlyRead = (tool: string) => NATIVE_INSTANTLY_READS.includes(tool);
/** The contact lookup that runs several providers; its receipt lists each person's emails. */
const FIND_EMAILS = "native_find_emails";

function correspondenceProvider(
  endpoint: string | null,
  view: "inbox" | "interview" | "contacts",
  firstPartyEndpoint?: string,
) {
  if (!endpoint) return null;
  let address: string;
  try {
    const url = new URL(endpoint);
    address = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
  if (view === "inbox") {
    if (endpoint === firstPartyEndpoint)
      return {
        kind: "crm",
        tools: [
          "list_crm_candidate_correspondence",
          "list_crm_role_correspondence",
          "list_crm_candidate_roles",
        ],
      };
    if (address === "https://mcp.instantly.ai/mcp")
      return { kind: "instantly", tools: ["list_emails", "get_email", ...NATIVE_INSTANTLY_READS] };
    if (address === "https://gmailmcp.googleapis.com/mcp/v1")
      return { kind: "gmail", tools: ["get_message", "get_thread", "search_threads"] };
  } else if (view === "interview") {
    if (address === "https://calendarmcp.googleapis.com/mcp/v1")
      return {
        kind: "calendar",
        tools: ["list_events", "get_event", "search_events", "suggest_time"],
      };
    if (address === "https://mcp.cal.com/mcp")
      return { kind: "cal", tools: ["get_bookings", "get_booking", "get_availability"] };
  } else if (address === "https://mcp.fullenrich.com/mcp") {
    return { kind: "fullenrich", tools: ["get_enrichment_results", FIND_EMAILS] };
  }
  return null;
}

function correspondenceCall(request: unknown) {
  const direct = boundDirectApprovalDetails(request, "__rakazoCatalogTool");
  if (direct) return direct;
  const catalog = catalogApprovalDetails(request, "__rakazoCatalogTool");
  // The executor appends the resolved route (request[3]) only after the catalog id or tool name
  // resolved to that exact tool, so the route is authoritative; the model-chosen `id` may be the
  // canonical "<server>:<tool>" or the tool's display name ("mcp__instantly__list_emails").
  if (!catalog?.route) return null;
  const args = catalog.args.arguments;
  return args && typeof args === "object" && !Array.isArray(args)
    ? { route: catalog.route, args: args as Record<string, unknown> }
    : null;
}

function correspondenceAllows(
  assignment: { allowAllTools: boolean; allowedTools: unknown },
  tool: string,
) {
  const assigned = isNativeInstantlyRead(tool)
    ? "list_emails"
    : tool === FIND_EMAILS
      ? "enrich_bulk"
      : tool;
  return (
    assignment.allowAllTools ||
    (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(assigned))
  );
}

function correspondenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserve only metadata supplied by the parsed provider record at this retained observation. */
function instantlyEmailObservation(
  email: NonNullable<ReturnType<typeof readInstantlyEmail>>,
  observedAt: Date,
) {
  const unread = email.is_unread;
  return {
    ...(unread !== undefined
      ? {
          unread:
            unread === true || unread === 1
              ? true
              : unread === false || unread === 0
                ? false
                : null,
        }
      : {}),
    ...(email.lead_id !== undefined ? { leadId: email.lead_id } : {}),
    ...(email.step !== undefined ? { step: email.step } : {}),
    observedAt: observedAt.toISOString(),
  };
}

function calAvailabilitySubject(args: Record<string, unknown>) {
  return [
    "eventTypeId",
    "eventTypeSlug",
    "username",
    "teamSlug",
    "organizationSlug",
    "usernames",
    "bookingUidToReschedule",
  ].map((key) => args[key] ?? null);
}

async function nativeRecruitingCorrespondence(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  selection: {
    roleId?: string;
    target?: Pick<
      RecruitingCrmTarget,
      "mcpServerId" | "serverRevision" | "organizationId" | "crmRoleId"
    >;
    candidateId?: string;
    crmEndpoint?: string;
  } = {},
) {
  const items: Array<ReturnType<typeof RecruitingNativeCorrespondenceSchema.parse>> = [];
  if (!selection.crmEndpoint) return { items, partial: false, assertCurrent: null };
  const captured = await recruiting.readRecruitingNativeCorrespondence(prisma, actor, {
    threadId,
    roleId: selection.roleId,
    target: selection.target,
  });
  if (!captured) return { items, partial: false, assertCurrent: null };
  if (
    captured.crmSource?.endpoint !== selection.crmEndpoint ||
    captured.crmSource.transport !== "streamable_http"
  )
    return { items, partial: true, assertCurrent: null };
  const seen = new Set<string>();
  let partial = captured.partial;
  const readEmails = new Map(
    [
      ...new Map(
        captured.records
          .flatMap((record) => [record.emailRead, ...record.reads])
          .map((read) => [read.id, read]),
      ).values(),
    ].map((read) => {
      const result = correspondenceRecord(read.result);
      return [
        read.id,
        read.status === "completed" &&
        result &&
        !("error" in result) &&
        (result.isError === undefined || result.isError === false)
          ? readInstantlyEmail(mcpObject(result))
          : null,
      ] as const;
    }),
  );
  for (const record of captured.records) {
    if (selection.candidateId && record.scope.candidateId !== selection.candidateId) continue;
    if (
      record.source.transport !== "streamable_http" ||
      correspondenceProvider(record.source.endpoint, "inbox")?.kind !== "instantly"
    )
      continue;
    const anchor = readEmails.get(record.emailRead.id);
    if (!anchor?.thread_id || anchor.id !== record.args.reply_to_uuid) {
      partial = true;
      continue;
    }
    const base = {
      roleId: captured.roleId,
      bindingEffectId: captured.bindingEffectId,
      crmRoleId: captured.target.crmRoleId,
      candidateId: record.scope.candidateId,
    };
    const append = (
      effect: typeof record.effect | typeof record.emailRead,
      status: "read" | "sent_recorded" | "scheduled" | "unknown",
      value: unknown,
    ) => {
      const key = `${effect.id}:${status}`;
      if (seen.has(key)) return;
      const email = value ? readInstantlyEmail(value) : null;
      const text =
        email &&
        (email.body.text ||
          (email.body.html ? htmlToPlainText(email.body.html) : "") ||
          email.content_preview ||
          "");
      const item = RecruitingNativeCorrespondenceSchema.safeParse({
        ...base,
        id: effect.id,
        status,
        checkedAt: effect.updatedAt.toISOString(),
        email: email && {
          id: `${record.source.id}:${email.id}`,
          sourceName: record.source.name,
          sourceId: record.source.id,
          providerMessageId: email.id,
          ...instantlyEmailObservation(email, effect.updatedAt),
          savedRead: effect.run.sourceMessageId
            ? {
                messageId: effect.run.sourceMessageId,
                linkedRunId: effect.run.id,
                effectId: effect.id,
              }
            : null,
          sender: email.from_address_email ?? null,
          recipients: [email.to_address_email_list],
          subject: email.subject,
          body: text!.slice(0, 50_000),
          snippet:
            email.body_fallback_reason != null ||
            !(email.body.text || email.body.html) ||
            text!.length > 50_000,
          date: email.timestamp_email,
          url: null,
        },
      });
      if (!item.success || (status !== "unknown" && !item.data.email)) {
        partial = true;
        return;
      }
      seen.add(key);
      items.push(item.data);
    };
    for (const read of record.reads) {
      const call = correspondenceCall(read.request);
      const email = readEmails.get(read.id);
      if (
        !email ||
        email.id !== call?.args.id ||
        email.organization_id !== anchor.organization_id ||
        email.eaccount !== anchor.eaccount ||
        email.thread_id !== anchor.thread_id
      )
        continue;
      append(read, "read", email);
    }
    const result = correspondenceRecord(record.effect.result);
    if (record.effect.status === "uncertain") {
      append(record.effect, "unknown", null);
      continue;
    }
    if (record.effect.status !== "completed") continue;
    const provider = correspondenceRecord(result?.providerResult);
    const sourceRead = [record.emailRead, ...record.reads].find(
      (read) => read.id === result?.sourceReadEffectId,
    );
    const outcome = classifyInstantlyReplyReceipt(
      record.args,
      anchor,
      sourceRead &&
        result &&
        !("error" in result) &&
        provider &&
        !("error" in provider) &&
        (provider.isError === undefined || provider.isError === false)
        ? mcpObject(provider)
        : undefined,
    );
    if (
      outcome.status === "unknown" ||
      outcome.status !== result?.status ||
      stableJsonValue(outcome.receipt) !== stableJsonValue(result.receipt)
    ) {
      append(record.effect, "unknown", null);
      partial = true;
      continue;
    }
    append(record.effect, outcome.status, mcpObject(provider));
  }
  const assertCurrent = async () => {
    if (!items.length) return;
    await prisma.$transaction(
      async (tx) => {
        const member = await recruiting.requireMembership(tx, actor.userId, actor.spaceId);
        if (member.userId !== actor.userId || member.spaceId !== actor.spaceId)
          throw new IsolationError();
        // Only current thread/role/binding can publish the captured evidence after pure parsing.
        const current = await tx.thread.findFirst({
          where: {
            id: threadId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            activeRecruitingRoleId: captured.roleId,
            activeRecruitingRole: { crmBindingEffectId: captured.bindingEffectId },
          },
          select: { id: true },
        });
        if (!current) throw new IsolationError();
        const serverIds = [...new Set(captured.authorizations.map((item) => item.server.id))];
        const servers = await tx.mcpServer.findMany({
          where: { id: { in: serverIds }, userId: actor.userId, spaceId: actor.spaceId },
          select: {
            id: true,
            userId: true,
            spaceId: true,
            enabled: true,
            revision: true,
            endpoint: true,
            transport: true,
            secretId: true,
          },
        });
        const assignments = await tx.botMcpServer.findMany({
          where: {
            serverId: { in: serverIds },
            botId: { in: [...new Set(captured.authorizations.map((item) => item.botId))] },
            userId: actor.userId,
            spaceId: actor.spaceId,
          },
        });
        for (const item of captured.authorizations) {
          const server = servers.find((value) => value.id === item.server.id);
          const assignment = assignments.find(
            (value) => value.serverId === item.server.id && value.botId === item.botId,
          );
          if (
            !server?.enabled ||
            server.userId !== actor.userId ||
            server.spaceId !== actor.spaceId ||
            server.revision !== item.server.revision ||
            server.endpoint !== item.server.endpoint ||
            server.transport !== item.server.transport ||
            Boolean(server.secretId) !== Boolean(item.server.secretId) ||
            !assignment ||
            assignment.userId !== actor.userId ||
            assignment.spaceId !== actor.spaceId ||
            !correspondenceAllows(assignment, item.tool)
          )
            throw new IsolationError();
        }
      },
      { isolationLevel: "RepeatableRead" },
    );
  };
  return { items, partial, assertCurrent };
}

/** Project saved native reads only. Opening a dashboard never invokes a provider. */
/**
 * The role's bound Instantly campaign (the `ensure_role_campaign` binding) with its live status and
 * lead statuses, read only through the read-only native tools of the conversation's own assigned
 * Instantly connection. The connector re-checks assignment and credential on every call.
 */
export async function getRecruitingRoleCampaign(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    signal?: AbortSignal;
    firstPartyMcpUrl?: string;
    reauthorize?: () => Promise<ThreadTarget>;
    stillAuthorized?: () => Promise<boolean>;
  },
  actor: Actor,
  target: ThreadTarget,
  selection: { campaignId?: string; campaignOffset?: number } = {},
): Promise<RecruitingRoleCampaign> {
  return authenticated(async () => {
    const none: RecruitingRoleCampaign = {
      status: "none",
      serverId: null,
      campaign: null,
      leads: [],
    };
    const workspace = await recruiting.getRecruitingWorkspace(deps.prisma, actor, {
      threadId: target.threadId,
    });
    if (!workspace) return none;
    let recheckImported: (() => Promise<void>) | undefined;
    let imported: { id: string; name: string } | null = null;
    if (workspace.crmTarget && workspace.crmTarget.bindingEffectId === null) {
      if (!deps.reauthorize)
        throw new ORPCError("FORBIDDEN", {
          message: "Current CRM role authorization is required.",
        });
      const selected = await recruiting.getRecruitingWorkspaceCrmTarget(deps.prisma, actor, {
        threadId: target.threadId,
      });
      if (!selected) throw new IsolationError();
      const page = await getRecruitingCrmData(
        { ...deps, reauthorize: deps.reauthorize },
        actor,
        target,
        {
          operation: "roleCampaigns",
          serverId: selected.mcpServerId,
          serverRevision: selected.serverRevision,
          organizationId: selected.organizationId,
          crmRoleId: selected.crmRoleId,
          limit: selection.campaignId ? 50 : 2,
          offset: selection.campaignOffset ?? 0,
        },
      );
      if (page.operation !== "roleCampaigns") throw new IsolationError();
      if (!selection.campaignId && (page.nextOffset !== null || page.items.length > 1))
        return { ...none, status: "unavailable", selectionRequired: true };
      imported = selection.campaignId
        ? (page.items.find((item) => item.id === selection.campaignId) ?? null)
        : (page.items[0] ?? null);
      if (selection.campaignId && !imported) throw new IsolationError();
      if (!imported) return none;
      recheckImported = async () => {
        const current = await recruiting.getRecruitingWorkspaceCrmTarget(deps.prisma, actor, {
          threadId: target.threadId,
        });
        if (stableJsonValue(current) !== stableJsonValue(selected)) throw new IsolationError();
        const fresh = await getRecruitingCrmData(
          { ...deps, reauthorize: deps.reauthorize! },
          actor,
          target,
          {
            operation: "roleCampaigns",
            serverId: selected.mcpServerId,
            serverRevision: selected.serverRevision,
            organizationId: selected.organizationId,
            crmRoleId: selected.crmRoleId,
            limit: selection.campaignId ? 50 : 2,
            offset: selection.campaignOffset ?? 0,
          },
        );
        if (
          fresh.operation !== "roleCampaigns" ||
          (selection.campaignId
            ? !fresh.items.some((item) => item.id === imported?.id)
            : fresh.nextOffset !== null ||
              fresh.items.length !== 1 ||
              fresh.items[0]?.id !== imported?.id)
        )
          throw new IsolationError();
      };
    }
    const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
    const assignment = await deps.prisma.botMcpServer.findFirst({
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: { in: botIds },
        server: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
          endpoint: "https://mcp.instantly.ai/mcp",
          transport: "streamable_http",
        },
      },
      orderBy: { botId: "asc" },
      select: {
        botId: true,
        allowAllTools: true,
        allowedTools: true,
        server: { select: { id: true, revision: true } },
      },
    });
    if (
      !assignment ||
      !["get_email", "list_emails"].every((tool) => correspondenceAllows(assignment, tool))
    )
      return imported
        ? {
            ...none,
            status: "unavailable",
            campaign: { ...imported, eaccount: null, status: null, stopOnReply: null },
          }
        : none;
    none.serverId = assignment.server.id;
    let binding: Record<string, unknown>;
    if (imported) {
      binding = { campaignId: imported.id, campaignName: imported.name };
    } else {
      const effect = await deps.prisma.externalEffect.findUnique({
        where: {
          idempotencyKey: `instantly-role-campaign:${assignment.server.id}:${workspace.role.id}`,
        },
        select: { spaceId: true, status: true, result: true },
      });
      const nativeBinding = correspondenceRecord(effect?.result);
      if (
        !effect ||
        effect.spaceId !== actor.spaceId ||
        effect.status !== "completed" ||
        typeof nativeBinding?.campaignId !== "string" ||
        typeof nativeBinding.campaignName !== "string"
      )
        return none;
      binding = nativeBinding;
    }
    const campaignId = binding.campaignId as string;
    if (selection.campaignId && selection.campaignId !== campaignId) throw new IsolationError();
    const campaignName = binding.campaignName as string;
    const eaccount = typeof binding.eaccount === "string" ? binding.eaccount : null;
    const context: AdapterContext = {
      operationId: randomUUID(),
      traceId: randomUUID(),
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: assignment.botId,
      signal: deps.signal ?? AbortSignal.timeout(30_000),
    };
    const read = async (tool: "get_campaign" | "list_leads", args: Record<string, unknown>) => {
      for await (const event of deps.connectors.execute(
        {
          tool: `native_instantly_${tool}`,
          route: {
            connectorId: "mcp",
            resourceId: assignment.server.id,
            resourceRevision: assignment.server.revision,
            toolName: `native_instantly_${tool}`,
          },
          args,
          executionId: randomUUID(),
        },
        context,
      )) {
        if (event.type === "result")
          return correspondenceRecord(
            correspondenceRecord(correspondenceRecord(event.data)?.structuredContent)?.result,
          );
        if (event.type === "error") return undefined;
      }
      return undefined;
    };
    const [campaign, leads] = await Promise.all([
      read("get_campaign", { campaign_id: campaignId }).catch(() => undefined),
      read("list_leads", { campaign_id: campaignId, limit: 100 }).catch(() => undefined),
    ]);
    if (recheckImported) await recheckImported();
    if (deps.stillAuthorized && !(await deps.stillAuthorized()))
      throw new ORPCError("UNAUTHORIZED");
    if (deps.reauthorize) {
      const current = await deps.reauthorize();
      const scope = (value: ThreadTarget) =>
        value.kind === "bot"
          ? [value.kind, value.threadId, value.botId]
          : [value.kind, value.threadId, value.groupId, value.memberBotIds];
      if (stableJsonValue(scope(current)) !== stableJsonValue(scope(target)))
        throw new IsolationError();
    }
    const currentAssignment = await deps.prisma.botMcpServer.findFirst({
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: assignment.botId,
        serverId: assignment.server.id,
        server: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
          revision: assignment.server.revision,
          endpoint: "https://mcp.instantly.ai/mcp",
          transport: "streamable_http",
        },
      },
      select: {
        botId: true,
        allowAllTools: true,
        allowedTools: true,
        server: { select: { id: true, revision: true } },
      },
    });
    if (
      !currentAssignment ||
      currentAssignment.server.id !== assignment.server.id ||
      currentAssignment.server.revision !== assignment.server.revision ||
      !["get_email", "list_emails"].every((tool) => correspondenceAllows(currentAssignment, tool))
    )
      throw new IsolationError();
    if (!campaign || campaign.id !== campaignId)
      return {
        status: "unavailable",
        serverId: assignment.server.id,
        campaign: {
          id: campaignId,
          name: campaignName,
          eaccount,
          status: null,
          stopOnReply: null,
        },
        leads: [],
      };
    const keyByEmail = new Map<string, string>();
    for (const [candidateKey, lead] of Object.entries(correspondenceRecord(binding.leads) ?? {})) {
      const email = correspondenceRecord(lead)?.email;
      if (typeof email === "string") keyByEmail.set(email.toLowerCase(), candidateKey);
    }
    const integer = (value: unknown) => (Number.isInteger(value) ? (value as number) : null);
    const rawLeads = Array.isArray(leads?.items) ? leads.items : null;
    // A full bounded page without a terminal receipt does not prove a complete campaign.
    const leadsComplete =
      rawLeads !== null &&
      rawLeads.length < 100 &&
      (leads?.next_starting_after === undefined || leads.next_starting_after === null) &&
      rawLeads.every((value) => typeof correspondenceRecord(value)?.email === "string");
    return {
      status: "ready",
      leadsComplete,
      serverId: assignment.server.id,
      campaign: {
        id: campaignId,
        name: typeof campaign.name === "string" ? campaign.name : campaignName,
        eaccount,
        status: integer(campaign.status),
        stopOnReply: typeof campaign.stop_on_reply === "boolean" ? campaign.stop_on_reply : null,
        observedDetails: campaignObservedDetails(campaign),
      },
      leads: (Array.isArray(leads?.items) ? leads.items : []).flatMap((value) => {
        const lead = correspondenceRecord(value);
        if (typeof lead?.email !== "string") return [];
        return [
          {
            candidateKey: keyByEmail.get(lead.email.toLowerCase()) ?? null,
            email: lead.email,
            status: integer(lead.status),
            interestStatus: integer(lead.lt_interest_status),
          },
        ];
      }),
    };
  });
}

/**
 * Role setup checklist for the frontend: campaign, sender mailbox, CRM link and leads. Reads only
 * saved bindings plus the read-only campaign view; nothing here creates or sends. CRM linking is
 * not required for outreach, so `ready` ignores it.
 */
export async function getRecruitingRoleSetup(
  deps: Parameters<typeof getRecruitingRoleCampaign>[0],
  actor: Actor,
  target: ThreadTarget,
): Promise<RecruitingRoleSetup> {
  return authenticated(async () => {
    const workspace = await recruiting.getRecruitingWorkspace(deps.prisma, actor, {
      threadId: target.threadId,
    });
    if (!workspace) return { ready: false, attention: null, items: [] };
    const [campaign, attention] = await Promise.all([
      getRecruitingRoleCampaign(deps, actor, target),
      roleAttention(deps.prisma, actor, workspace.role.id),
    ]);
    const items: RecruitingRoleSetup["items"] = [];
    if (campaign.campaign) {
      items.push({
        key: "campaign",
        state: campaign.status === "ready" ? "ready" : "unavailable",
        label: campaign.campaign.name,
        detail: {
          id: campaign.campaign.id,
          name: campaign.campaign.name,
          status: campaign.campaign.status,
          ...(campaign.leadsComplete === true ? { leadCount: campaign.leads.length } : {}),
        },
      });
      const email = campaign.campaign.eaccount;
      items.push(
        email
          ? { key: "sender", state: "ready", label: email, detail: { email } }
          : { key: "sender", state: "unavailable", label: "Sender unknown" },
      );
    } else if (campaign.selectionRequired) {
      items.push(
        { key: "campaign", state: "unavailable", label: "Select an existing campaign in Sequence" },
        {
          key: "sender",
          state: "unavailable",
          label: "Sender unknown until a campaign is selected",
        },
      );
    } else if (!campaign.serverId) {
      const server = await deps.prisma.mcpServer.findFirst({
        where: { userId: actor.userId, spaceId: actor.spaceId, endpoint: INSTANTLY_MCP_ENDPOINT },
        select: { id: true },
      });
      const action = { kind: "connect" as const, ...(server ? { serverId: server.id } : {}) };
      items.push(
        { key: "campaign", state: "unavailable", label: "Instantly is not connected", action },
        { key: "sender", state: "unavailable", label: "Instantly is not connected", action },
      );
    } else {
      items.push({
        key: "campaign",
        state: "missing",
        label: "First email not prepared yet; prepared automatically on first outreach",
        action: { kind: "ask_agent", prompt: "Prepare the first email for this role" },
      });
      const email = await lastUsedMailbox(deps.prisma, actor.spaceId, campaign.serverId);
      items.push(
        email
          ? { key: "sender", state: "ready", label: email, detail: { email } }
          : {
              key: "sender",
              state: "missing",
              label: "Sender picked automatically on first use",
            },
      );
    }
    const crm = workspace.crmTarget?.target;
    items.push(
      crm
        ? {
            key: "crm",
            state: "ready",
            label: `${crm.clientLabel} / ${crm.roleLabel}`,
            detail: { orgId: crm.organizationId, roleLabel: crm.roleLabel },
          }
        : {
            key: "crm",
            state: "missing",
            label: "Role record not linked yet",
            action: { kind: "ask_agent", prompt: "Prepare the candidate list for this role" },
          },
    );
    const count = campaign.leads.length;
    items.push(
      campaign.status !== "none" && campaign.leadsComplete !== true
        ? { key: "leads", state: "unavailable", label: "Recipient count unavailable" }
        : count
          ? { key: "leads", state: "ready", label: `${count} recipients`, detail: { count } }
          : {
              key: "leads",
              state: "missing",
              label: "No recipients for the first email yet",
              detail: { count },
              action: {
                kind: "ask_agent",
                prompt: "Add the shortlisted candidates as recipients of the first email",
              },
            },
    );
    const ready = (key: string) => items.some((item) => item.key === key && item.state === "ready");
    const playbook = await recruiting
      .readRecruitingPlaybookStep(deps.prisma, workspace.role.id)
      .catch(() => null);
    const rawStage = playbook?.stage ?? workspace.role.playbookStage;
    const stage: RecruitingPlaybookStage = isRecruitingPlaybookStage(rawStage)
      ? rawStage
      : "intake";
    return {
      ready: ready("campaign") && ready("sender") && ready("leads"),
      attention,
      items,
      playbookStage: {
        stage,
        label: recruitingPlaybookStageLabels[stage],
        nextStep: playbook?.step?.label ?? null,
      },
    };
  });
}

/** The newest run waiting for the human in a conversation linked to this role, with its ask card. */
async function roleAttention(
  prisma: PrismaClient,
  actor: Actor,
  roleId: string,
): Promise<RecruitingRoleSetup["attention"]> {
  const run = await prisma.run.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "waiting_input",
      thread: { activeRecruitingRoleId: roleId, userId: actor.userId, spaceId: actor.spaceId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, threadId: true, createdAt: true },
  });
  if (!run) return null;
  // Same lookup shape as answerRunInput: the bot message carrying the pending ask block.
  const card = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      runId: run.id,
      role: "bot",
      blocks: { array_contains: [{ kind: "ask", status: "pending" }] },
    },
    orderBy: { seq: "desc" },
    select: { id: true, createdAt: true, blocks: true },
  });
  return {
    kind: pendingInputAttention(card?.blocks) ?? "question",
    threadId: run.threadId,
    cardId: card?.id ?? null,
    createdAt: (card?.createdAt ?? run.createdAt).toISOString(),
  };
}

/** Scoped operation outcomes remain separate from calendar events: no receipt joins them. */
async function recruitingReplyOutcomes(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  roleId: string,
  sources: {
    id: string;
    name: string;
    endpoint: string | null;
    transport: string;
    enabled: boolean;
    revision: number;
    assignments: { botId: string; allowAllTools: boolean; allowedTools: unknown }[];
  }[],
) {
  const tool = "native_instantly_reply_to_email";
  const grants = (source: (typeof sources)[number], botId: string) =>
    source.enabled &&
    source.endpoint === INSTANTLY_MCP_ENDPOINT &&
    source.transport === "streamable_http" &&
    source.assignments.some((assignment) => {
      const allowed = assignment.allowedTools;
      return (
        assignment.botId === botId &&
        (assignment.allowAllTools ||
          (Array.isArray(allowed) &&
            ["get_email", "list_emails"].every((name) => allowed.includes(name))))
      );
    });
  const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
  const eligible = sources.filter((source) => botIds.some((botId) => grants(source, botId)));
  if (!eligible.length) return { operations: [], partial: false };
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      status: { in: ["completed", "failed", "uncertain"] },
      run: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: { in: botIds },
        initialRecruitingRoleRevision: { roleId },
      },
      OR: eligible.flatMap((source) => [
        {
          AND: [
            { request: { path: ["2", "route", "resourceId"], equals: source.id } },
            { request: { path: ["2", "route", "toolName"], equals: tool } },
          ],
        },
        {
          AND: [
            { request: { path: ["3", "resourceId"], equals: source.id } },
            { request: { path: ["3", "toolName"], equals: tool } },
          ],
        },
      ]),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 101,
    select: {
      id: true,
      spaceId: true,
      status: true,
      request: true,
      result: true,
      updatedAt: true,
      run: {
        select: {
          userId: true,
          spaceId: true,
          threadId: true,
          botId: true,
          initialRecruitingRoleRevision: { select: { roleId: true } },
        },
      },
    },
  });
  const operations: NonNullable<RecruitingCorrespondence["operations"]> = [];
  const exposed: { sourceId: string; revision: number; botId: string }[] = [];
  for (const effect of effects.slice(0, 100)) {
    const run = effect.run;
    if (
      effect.spaceId !== actor.spaceId ||
      run.userId !== actor.userId ||
      run.spaceId !== actor.spaceId ||
      run.threadId !== target.threadId ||
      !botIds.includes(run.botId) ||
      run.initialRecruitingRoleRevision?.roleId !== roleId
    )
      continue;
    const call = correspondenceCall(effect.request);
    const source = eligible.find((item) => item.id === call?.route.resourceId);
    if (
      call?.route.connectorId !== "mcp" ||
      call.route.toolName !== tool ||
      !source ||
      call.route.resourceRevision !== source.revision ||
      !grants(source, run.botId) ||
      typeof call.args.reply_to_uuid !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        call.args.reply_to_uuid,
      )
    )
      continue;
    const result = correspondenceRecord(effect.result);
    const outcome =
      effect.status === "uncertain" || result?.uncertain === true
        ? "uncertain"
        : effect.status === "failed" ||
            typeof result?.error === "string" ||
            result?.isError === true
          ? "failed"
          : null;
    if (!outcome) continue;
    operations.push({
      id: effect.id,
      kind: "reply",
      outcome,
      checkedAt: effect.updatedAt.toISOString(),
      sourceName: source.name,
      sourceId: source.id,
      providerMessageId: call.args.reply_to_uuid,
    });
    exposed.push({ sourceId: source.id, revision: source.revision, botId: run.botId });
  }
  const currentSources = await prisma.mcpServer.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      id: { in: eligible.map((source) => source.id) },
    },
    select: {
      id: true,
      name: true,
      endpoint: true,
      transport: true,
      enabled: true,
      revision: true,
      assignments: {
        where: { userId: actor.userId, spaceId: actor.spaceId, botId: { in: botIds } },
        select: { botId: true, allowAllTools: true, allowedTools: true },
      },
    },
  });
  for (const operation of exposed) {
    const current = currentSources.find((source) => source.id === operation.sourceId);
    if (!current || current.revision !== operation.revision || !grants(current, operation.botId))
      throw new IsolationError();
  }
  const current = await recruiting.getRecruitingWorkspace(prisma, actor, {
    threadId: target.threadId,
  });
  if (current?.role.id !== roleId) throw new IsolationError();
  return { operations, partial: effects.length > 100 };
}

export async function getRecruitingCorrespondence(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  view: "inbox" | "interview" | "contacts",
  productIdentity?: { endpoint: string; connected: boolean },
  oauth?: Pick<McpOAuthBroker, "statusFor">,
  page: { limit?: number; cursor?: string } = {},
  crmReads?: Omit<RecruitingCrmReadDeps, "prisma">,
): Promise<RecruitingCorrespondence> {
  return authenticated(async () => {
    const workspace = await recruiting.getRecruitingWorkspace(prisma, actor, {
      threadId: target.threadId,
    });
    const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
    const servers = await prisma.mcpServer.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      select: {
        id: true,
        name: true,
        endpoint: true,
        transport: true,
        secretId: true,
        enabled: true,
        revision: true,
        assignments: {
          where: { userId: actor.userId, spaceId: actor.spaceId, botId: { in: botIds } },
          select: { botId: true, allowAllTools: true, allowedTools: true },
        },
      },
    });
    const sourceRows = servers.map((server) => ({
      ...server,
      provider: correspondenceProvider(
        server.endpoint,
        view,
        server.transport === "streamable_http" ? productIdentity?.endpoint : undefined,
      ),
    }));
    const sources = sourceRows.filter((source) => source.provider !== null);
    const output: RecruitingCorrespondence = {
      roleId: workspace?.role.id ?? null,
      status: "not_checked",
      checkedAt: null,
      connectionChanged: false,
      emails: [],
      events: [],
      contacts: [],
      partial: false,
      nextCursor: null,
      connections: await Promise.all(
        sources.map(async (source): Promise<RecruitingCorrespondence["connections"][number]> => {
          let identityConnected = productIdentity?.connected;
          if (source.enabled && source.provider?.kind === "crm" && source.secretId) {
            try {
              identityConnected = (await oauth?.statusFor(source, actor)) === "connected";
            } catch (error) {
              if (!(error instanceof SecretStoreUnavailableError)) throw error;
              return { name: source.name, status: "unavailable", checkIssue: null };
            }
          }
          return {
            name: source.name,
            checkIssue: null,
            status: !source.enabled
              ? "disabled"
              : (
                    source.provider?.kind === "crm"
                      ? !identityConnected
                      : !source.secretId && !hasPlatformMcpCredential(source)
                  )
                ? "needs_connection"
                : !source.assignments.some((assignment) =>
                      source.provider?.tools.some(
                        (tool) =>
                          tool !== "list_crm_candidate_roles" &&
                          correspondenceAllows(assignment, tool),
                      ),
                    )
                  ? "needs_access"
                  : "configured",
          };
        }),
      ),
    };
    let assertCalendarLineageCurrent: (() => Promise<void>) | undefined;
    const finish = async () => {
      let assertNativeCurrent: (() => Promise<void>) | null = null;
      if (workspace && view === "inbox") {
        const native = await nativeRecruitingCorrespondence(prisma, actor, target.threadId, {
          roleId: workspace.role.id,
          crmEndpoint: productIdentity?.endpoint,
        });
        const emails = new Map(output.emails.map((email) => [email.id, email]));
        const latest = new Map<string, (typeof native.items)[number]>();
        for (const item of native.items) {
          if (
            item.email &&
            (!latest.has(item.email.id) || item.checkedAt > latest.get(item.email.id)!.checkedAt)
          )
            latest.set(item.email.id, item);
          if (!output.checkedAt || item.checkedAt > output.checkedAt)
            output.checkedAt = item.checkedAt;
        }
        for (const item of latest.values()) if (item.email) emails.set(item.email.id, item.email);
        output.partial ||= native.partial || native.items.some((item) => item.status === "unknown");
        output.emails = [...emails.values()];
        if (output.emails.length) output.status = "ready";
        assertNativeCurrent = native.assertCurrent;
      }
      // Read the same authorized CRM role used by the workspace, without inventing a saved tool receipt.
      const start = Number(page.cursor ?? 0);
      const end = start + (page.limit ?? 50);
      if (workspace && view === "inbox" && crmReads) {
        const attached = await recruiting.getRecruitingWorkspaceCrmTarget(prisma, actor, {
          threadId: target.threadId,
        });
        if (attached) {
          // Current role mail supersedes historical CRM reads; keep other provider receipts.
          const emails = new Map(
            output.emails
              .filter((email) => email.sourceId !== attached.mcpServerId)
              .map((email) => [email.id, email]),
          );
          let offset = 0;
          let fetched = 0;
          const seen = new Set<string>();
          while (fetched <= end) {
            const history = await getRecruitingCrmData({ ...crmReads, prisma }, actor, target, {
              operation: "roleMail",
              serverId: attached.mcpServerId,
              serverRevision: attached.serverRevision,
              organizationId: attached.organizationId,
              crmRoleId: attached.crmRoleId,
              limit: Math.min(50, end + 1 - fetched),
              offset,
            });
            if (history.operation !== "roleMail") throw new ORPCError("SERVICE_UNAVAILABLE");
            if (!history.supported) throw new ORPCError("SERVICE_UNAVAILABLE");
            const connection = output.connections.find(
              (_, index) => sources[index]?.id === attached.mcpServerId,
            );
            if (connection) {
              connection.status = "configured";
              connection.checkIssue = null;
            }
            output.checkedAt = history.checkedAt;
            for (const email of history.items) {
              if (seen.has(email.providerMessageId)) throw new ORPCError("SERVICE_UNAVAILABLE");
              seen.add(email.providerMessageId);
              const id = stableJsonValue([
                attached.mcpServerId,
                attached.organizationId,
                email.candidateId,
                email.providerMessageId,
              ]);
              emails.set(id, {
                id,
                sourceName: history.source.name,
                sourceId: attached.mcpServerId,
                crm: {
                  serverRevision: attached.serverRevision,
                  organizationId: attached.organizationId,
                  crmRoleId: attached.crmRoleId,
                  candidateId: email.candidateId,
                  threadId: email.threadId,
                  campaignId: email.campaignId,
                  direction: email.direction,
                  ...(email.eaccount !== undefined ? { eaccount: email.eaccount } : {}),
                },
                providerThreadId: email.threadId,
                campaignId: email.campaignId,
                ...(email.eaccount !== undefined ? { eaccount: email.eaccount } : {}),
                providerMessageId: email.providerMessageId,
                savedRead: null,
                sender: email.sender,
                recipients: email.recipients,
                subject: email.subject ?? "",
                body: email.body ?? "",
                snippet: email.partial,
                date: email.date,
                url: null,
              });
            }
            fetched += history.items.length;
            if (history.nextOffset === null) break;
            if (!history.items.length || history.nextOffset !== offset + history.items.length)
              throw new ORPCError("SERVICE_UNAVAILABLE");
            offset = history.nextOffset;
          }
          const current = await recruiting.getRecruitingWorkspaceCrmTarget(prisma, actor, {
            threadId: target.threadId,
          });
          if (stableJsonValue(current) !== stableJsonValue(attached)) throw new IsolationError();
          // Preserve the CRM's global timestamp/message-id order across candidates and time zones.
          const timestamp = (value: string | null) =>
            value === null
              ? ""
              : new Date(value).toISOString().slice(0, 19) +
                "." +
                (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0");
          output.emails = [...emails.values()].sort(
            (left, right) =>
              timestamp(right.date).localeCompare(timestamp(left.date)) ||
              right.providerMessageId.localeCompare(left.providerMessageId) ||
              right.id.localeCompare(left.id),
          );
          if (output.emails.length) output.status = "ready";
          else if (output.status !== "unsupported") output.status = "empty";
        }
      }
      await assertNativeCurrent?.();
      await assertCalendarLineageCurrent?.();
      if (workspace && view === "interview") {
        const outcomes = await recruitingReplyOutcomes(
          prisma,
          actor,
          target,
          workspace.role.id,
          sourceRows,
        );
        output.operations = outcomes.operations;
        output.partial ||= outcomes.partial;
      }
      // Offset over the merged inbox order; refresh from page one after new mail.
      output.nextCursor = output.emails.length > end ? String(end) : null;
      // Unpaged callers keep the old "more than one screen of mail" signal.
      output.partial ||= output.nextCursor !== null;
      output.emails = output.emails.slice(start, end);
      return output;
    };
    if (!workspace) return finish();
    const readTools =
      view === "inbox"
        ? [
            "list_emails",
            "get_email",
            ...NATIVE_INSTANTLY_READS,
            "get_message",
            "get_thread",
            "search_threads",
            "list_crm_candidate_correspondence",
            "list_crm_candidate_roles",
          ]
        : view === "interview"
          ? [
              "get_bookings",
              "get_booking",
              "get_availability",
              "list_events",
              "get_event",
              "search_events",
              "suggest_time",
            ]
          : ["get_enrichment_results", FIND_EMAILS];
    const querySources = sourceRows.filter(
      (source) =>
        source.enabled &&
        source.assignments.some((assignment) =>
          readTools.some((tool) => correspondenceAllows(assignment, tool)),
        ),
    );
    if (!querySources.length) return finish();
    // Keep historical reads of the same role, including native legacy runs without an initial revision.
    const scope = {
      spaceId: actor.spaceId,
      run: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: target.threadId,
        botId: { in: botIds },
        OR: [
          { initialRecruitingRoleRevisionId: null },
          { initialRecruitingRoleRevision: { roleId: workspace.role.id } },
        ],
      },
      status: { in: ["completed", "failed"] },
    };
    const retained = await prisma.externalEffect.findMany({
      where: {
        ...scope,
        OR: querySources.flatMap((source) =>
          (source.provider?.tools ?? readTools).flatMap((tool) => [
            {
              AND: [
                { request: { path: ["2", "route", "resourceId"], equals: source.id } },
                { request: { path: ["2", "route", "toolName"], equals: tool } },
              ],
            },
            {
              AND: [
                { request: { path: ["3", "resourceId"], equals: source.id } },
                { request: { path: ["3", "toolName"], equals: tool } },
              ],
            },
          ]),
        ),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 201,
      select: {
        id: true,
        request: true,
        status: true,
        updatedAt: true,
        run: { select: { id: true, botId: true, sourceMessageId: true } },
      },
    });
    // ponytail: bound saved display history to 200 matching reads; a native fresh check refreshes older coverage.
    output.partial = retained.length > 200;
    const seen = new Set<string>();
    const crmMemberships = new Map<
      string,
      { effectId: string; status: string; updatedAt: Date; readable: boolean }
    >();
    let unsupported = false;
    let failed = false;
    const connections = new Map(
      sources.map((source, index) => [source.id, output.connections[index]!]),
    );
    const checkIssue = (
      sourceId: string,
      updatedAt: Date,
      status: "failed" | "unsupported" = "unsupported",
    ) => {
      if (status === "failed") failed = true;
      else unsupported = true;
      const connection = connections.get(sourceId);
      const checkedAt = updatedAt.toISOString();
      if (connection && (!connection.checkIssue || checkedAt > connection.checkIssue.checkedAt))
        connection.checkIssue = { status, checkedAt };
    };
    const reads = retained.slice(0, 200).flatMap((effect) => {
      const call = correspondenceCall(effect.request);
      const source = sourceRows.find(
        (source) => source.id === call?.route.resourceId && source.enabled,
      );
      if (
        call?.route.connectorId !== "mcp" ||
        !source ||
        !(source.provider?.tools ?? readTools).includes(call.route.toolName)
      )
        return [];
      const permission = source.assignments.find(
        (assignment) => assignment.botId === effect.run.botId,
      );
      if (
        source.provider?.kind === "crm" &&
        call.route.toolName === "list_crm_candidate_roles" &&
        [call.args.p_org, call.args.p_candidate].every(
          (value) => typeof value === "string" && value.trim(),
        )
      ) {
        const key = stableJsonValue([source.id, call.args.p_org, call.args.p_candidate]);
        if (!crmMemberships.has(key))
          crmMemberships.set(key, {
            effectId: effect.id,
            status: effect.status,
            updatedAt: effect.updatedAt,
            readable: Boolean(
              permission &&
                correspondenceAllows(permission, call.route.toolName) &&
                call.route.resourceRevision === source.revision,
            ),
          });
      }
      if (!permission || !correspondenceAllows(permission, call.route.toolName)) return [];
      const query = Object.fromEntries(
        Object.entries(call.args).filter(([key]) => key !== "limit"),
      );
      const campaignId = call.args.campaign_id;
      // A list_emails read made in this role's thread is this role's mailbox check, whether it was
      // campaign-scoped, lead-scoped or unscoped; the thread/bot scope above is the role boundary.
      if (
        source.provider?.kind === "crm" &&
        [call.args.p_org, call.args.p_candidate].some(
          (value) => typeof value !== "string" || !value.trim(),
        )
      ) {
        if (call.route.toolName === "list_crm_candidate_roles") return [];
        checkIssue(source.id, effect.updatedAt);
        output.checkedAt ??= effect.updatedAt.toISOString();
        return [];
      }
      const key = stableJsonValue([
        source.id,
        call.route.toolName,
        call.route.toolName === "list_emails"
          ? // One snapshot per campaign; a lead-scoped or unscoped list is its own exact query.
            typeof campaignId === "string"
            ? { campaign_id: campaignId }
            : query
          : source.provider?.kind === "crm"
            ? { p_org: call.args.p_org, p_candidate: call.args.p_candidate }
            : source.provider?.kind === "cal" && call.route.toolName === "get_availability"
              ? calAvailabilitySubject(call.args)
              : source.provider?.kind === "gmail" && call.route.toolName !== "search_threads"
                ? call.route.toolName === "get_message"
                  ? { messageId: call.args.messageId }
                  : { threadId: call.args.threadId }
                : query,
      ]);
      // ponytail: Inbox shows the latest campaign check, not accumulated mailbox history; native cursor coverage stays explicit.
      // A new check replaces the prior observation, including empty/error.
      if (seen.has(key)) return [];
      seen.add(key);
      if (call.route.resourceRevision !== source.revision || !source.provider) {
        if (call.route.toolName === "list_crm_candidate_roles") return [];
        checkIssue(source.id, effect.updatedAt);
        output.checkedAt ??= effect.updatedAt.toISOString();
        output.connectionChanged ||= call.route.resourceRevision !== source.revision;
        return [];
      }
      return [{ effect, call, source, provider: source.provider }];
    });
    if (!reads.length) {
      if (unsupported) output.status = "unsupported";
      return finish();
    }
    const results = await prisma.externalEffect.findMany({
      where: { ...scope, id: { in: reads.map((read) => read.effect.id) } },
      select: { id: true, result: true },
    });
    const byId = new Map(results.map((result) => [result.id, result.result]));
    // A read made in this role's run can contain the whole calendar. Only an actual
    // completed creation in this exact role establishes initial ownership. A successful
    // reschedule receipt may then prove the provider's replacement UID, never a name/time guess.
    const bookingProofs = new Set<string>();
    const supersededBookings = new Set<string>();
    if (
      reads.some(
        ({ provider, call }) =>
          provider.kind === "cal" && call.route.toolName !== "get_availability",
      )
    ) {
      const receipts = await prisma.externalEffect.findMany({
        where: {
          ...scope,
          status: "completed",
          run: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: target.threadId,
            botId: { in: botIds },
            initialRecruitingRoleRevision: { roleId: workspace.role.id },
          },
          OR: querySources
            .filter((source) => source.provider?.kind === "cal")
            .flatMap((source) =>
              ["create_booking", "reschedule_booking"].flatMap((tool) => [
                {
                  AND: [
                    { request: { path: ["2", "route", "resourceId"], equals: source.id } },
                    { request: { path: ["2", "route", "toolName"], equals: tool } },
                  ],
                },
                {
                  AND: [
                    { request: { path: ["3", "resourceId"], equals: source.id } },
                    { request: { path: ["3", "toolName"], equals: tool } },
                  ],
                },
              ]),
            ),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 201,
        select: {
          request: true,
          result: true,
          status: true,
          run: {
            select: {
              userId: true,
              spaceId: true,
              threadId: true,
              botId: true,
              initialRecruitingRoleRevision: { select: { roleId: true } },
            },
          },
        },
      });
      output.partial ||= receipts.length > 200;
      const lineage: {
        sourceId: string;
        revision: number;
        botId: string;
        from: string;
        to: string;
      }[] = [];
      for (const receipt of receipts.slice(0, 200)) {
        const call = correspondenceCall(receipt.request);
        const source = querySources.find((source) => source.id === call?.route.resourceId);
        const result = correspondenceRecord(receipt.result);
        const body = mcpObject(receipt.result);
        const booking = correspondenceRecord(body?.data);
        if (
          receipt.status !== "completed" ||
          receipt.run.userId !== actor.userId ||
          receipt.run.spaceId !== actor.spaceId ||
          receipt.run.threadId !== target.threadId ||
          !botIds.includes(receipt.run.botId) ||
          receipt.run.initialRecruitingRoleRevision?.roleId !== workspace.role.id ||
          call?.route.connectorId !== "mcp" ||
          !["create_booking", "reschedule_booking"].includes(call.route.toolName) ||
          source?.provider?.kind !== "cal" ||
          call.route.resourceRevision !== source.revision ||
          result?.isError === true ||
          result?.uncertain === true ||
          result?.error !== undefined ||
          body?.status !== "success" ||
          typeof booking?.uid !== "string" ||
          !booking.uid.trim()
        )
          continue;
        const permission = source.assignments.find(
          (assignment) => assignment.botId === receipt.run.botId,
        );
        if (
          !permission ||
          !["get_booking", "get_bookings"].some((tool) => correspondenceAllows(permission, tool))
        )
          continue;
        if (call.route.toolName === "create_booking") {
          bookingProofs.add(stableJsonValue([source.id, source.revision, booking.uid]));
        } else if (
          typeof call.args.bookingUid === "string" &&
          call.args.bookingUid.trim() &&
          booking.rescheduledFromUid === call.args.bookingUid &&
          booking.uid !== call.args.bookingUid
        ) {
          lineage.push({
            sourceId: source.id,
            revision: source.revision,
            botId: receipt.run.botId,
            from: call.args.bookingUid,
            to: booking.uid,
          });
        }
      }
      const adopted: typeof lineage = [];
      // Receipts arrive newest-first. Resolve only chains rooted in an owned creation.
      let remaining = lineage;
      while (remaining.length) {
        const deferred: typeof lineage = [];
        let advanced = false;
        for (const link of remaining) {
          if (!bookingProofs.has(stableJsonValue([link.sourceId, link.revision, link.from]))) {
            deferred.push(link);
            continue;
          }
          bookingProofs.add(stableJsonValue([link.sourceId, link.revision, link.to]));
          adopted.push(link);
          supersededBookings.add(stableJsonValue([link.sourceId, link.revision, link.from]));
          advanced = true;
        }
        if (!advanced) break;
        remaining = deferred;
      }
      if (adopted.length)
        assertCalendarLineageCurrent = async () => {
          const currentSources = await prisma.mcpServer.findMany({
            where: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              id: { in: [...new Set(adopted.map((link) => link.sourceId))] },
            },
            select: {
              id: true,
              endpoint: true,
              enabled: true,
              revision: true,
              assignments: {
                where: { userId: actor.userId, spaceId: actor.spaceId, botId: { in: botIds } },
                select: { botId: true, allowAllTools: true, allowedTools: true },
              },
            },
          });
          for (const link of adopted) {
            const source = currentSources.find((source) => source.id === link.sourceId);
            const permission = source?.assignments.find(
              (assignment) => assignment.botId === link.botId,
            );
            if (
              !source?.enabled ||
              source.revision !== link.revision ||
              correspondenceProvider(source.endpoint, "interview")?.kind !== "cal" ||
              !permission ||
              !["get_booking", "get_bookings"].some((tool) =>
                correspondenceAllows(permission, tool),
              )
            )
              throw new IsolationError();
          }
          const current = await recruiting.getRecruitingWorkspace(prisma, actor, {
            threadId: target.threadId,
          });
          if (current?.role.id !== workspace.role.id) throw new IsolationError();
        };
    }
    const candidateKeys = new Set(
      view === "contacts"
        ? (
            await prisma.recruitingCandidate.findMany({
              where: {
                roleId: workspace.role.id,
                role: { spaceId: actor.spaceId, userId: actor.userId },
              },
              select: { candidateKey: true },
            })
          ).map((candidate) => candidate.candidateKey)
        : [],
    );
    const contactKeys = new Set<string>();
    let parsed = false;
    const emails = new Map<string, RecruitingCorrespondence["emails"][number]>();
    const instantlyObservedAt = new Map<string, Date>();
    const gmailMessages = new Map<string, string>();
    const gmailThreads = new Map<string, string>();
    const events = new Map<string, RecruitingCorrespondence["events"][number]>();
    let crmBinding: Awaited<ReturnType<typeof recruiting.getRecruitingCrmTarget>> | undefined;
    const crmPages: Array<{
      sourceId: string;
      updatedAt: Date;
      candidateId: string;
      importEffectId: string;
      messages: RecruitingCorrespondence["emails"];
    }> = [];
    // Full-body reads (get_email) are projected after list snapshots so they replace previews.
    const DETAIL_READS = ["get_email", "native_instantly_get_email"];
    const campaignRead = (read: (typeof reads)[number]) =>
      read.provider.kind === "instantly" &&
      read.call.route.toolName === "list_emails" &&
      typeof read.call.args.campaign_id === "string";
    const projections = [
      // Establish campaign snapshots before broader reads can contribute older messages.
      ...reads.filter(campaignRead),
      ...reads.filter(
        (read) =>
          !campaignRead(read) &&
          ![...DETAIL_READS, "list_crm_candidate_roles"].includes(read.call.route.toolName),
      ),
      ...reads.filter((read) => DETAIL_READS.includes(read.call.route.toolName)),
    ];
    // Latest campaign list snapshots: a detail read of a campaign email that a not-older list of
    // the same campaign no longer shows is stale history, never revived.
    const campaignLists = new Map<string, { updatedAt: Date; ids: Set<string> }>();
    const revived = (
      sourceId: string,
      campaignId: string | null | undefined,
      id: string,
      at: Date,
    ) => {
      const list = campaignId ? campaignLists.get(`${sourceId}:${campaignId}`) : undefined;
      return Boolean(list && list.updatedAt >= at && !list.ids.has(id));
    };
    for (const { effect, call, source, provider } of projections) {
      const detailRead =
        provider.kind === "instantly" && DETAIL_READS.includes(call.route.toolName);
      if (
        provider.kind === "instantly" &&
        call.route.toolName === "list_emails" &&
        typeof call.args.campaign_id === "string"
      )
        campaignLists.set(`${source.id}:${call.args.campaign_id}`, {
          updatedAt: effect.updatedAt,
          ids: new Set(),
        });
      const savedRead = effect.run.sourceMessageId
        ? { messageId: effect.run.sourceMessageId, linkedRunId: effect.run.id, effectId: effect.id }
        : null;
      if (provider.kind === "gmail" && call.route.toolName !== "search_threads") {
        const thread = call.route.toolName === "get_thread";
        const selectedId = thread ? call.args.threadId : call.args.messageId;
        if (typeof selectedId === "string" && selectedId.trim()) {
          const claims = thread ? gmailThreads : gmailMessages;
          const key = `${source.id}:${selectedId}`;
          if (claims.has(key)) continue;
          // The latest authorized identity observation replaces older bodies even on failure.
          claims.set(key, effect.id);
        }
      }
      const result = byId.get(effect.id);
      if (result === undefined) continue;
      output.checkedAt ??= effect.updatedAt.toISOString();
      if (
        effect.status === "failed" ||
        (result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          ("error" in result ||
            ("isError" in result && result.isError !== false && result.isError !== undefined)))
      ) {
        // A failed detail read beside a campaign snapshot adds nothing to that mailbox check.
        if (!(detailRead && campaignLists.size)) checkIssue(source.id, effect.updatedAt, "failed");
        continue;
      }
      // The Inbox header shows the latest readable check, whichever read it was.
      const checkedAt = effect.updatedAt.toISOString();
      if (checkedAt > output.checkedAt) output.checkedAt = checkedAt;
      const body = mcpObject(result);
      if (provider.kind === "crm") {
        const data = correspondenceRecord(body?.data);
        const cursorMatches = (value: unknown) => {
          const cursor = correspondenceRecord(value);
          return (
            cursor !== undefined &&
            cursor.p_org === call.args.p_org &&
            cursor.p_candidate === call.args.p_candidate &&
            [cursor.linked_offset, cursor.unlinked_offset].every(
              (offset) =>
                typeof offset === "number" &&
                Number.isSafeInteger(offset) &&
                offset >= 0 &&
                offset <= Number.MAX_SAFE_INTEGER - 51,
            )
          );
        };
        const limit = call.args.p_limit === undefined ? 10 : call.args.p_limit;
        if (
          !data ||
          data.organization_id !== call.args.p_org ||
          data.candidate_id !== call.args.p_candidate ||
          data.pagination !== "offset" ||
          !Array.isArray(data.messages) ||
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          data.messages.length > limit ||
          (call.args.p_cursor !== undefined && !cursorMatches(call.args.p_cursor)) ||
          (data.next_cursor !== null && !cursorMatches(data.next_cursor))
        ) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        const messages = data.messages.map((value) => {
          const row = correspondenceRecord(value);
          if (
            typeof row?.id !== "string" ||
            !row.id.trim() ||
            row.organization_id !== call.args.p_org ||
            (row.candidate_id !== null && row.candidate_id !== call.args.p_candidate) ||
            (row.body_text !== null && typeof row.body_text !== "string")
          )
            return null;
          const message = RecruitingCorrespondenceSchema.shape.emails.element.safeParse({
            id: stableJsonValue([source.id, call.args.p_org, call.args.p_candidate, row.id]),
            sourceName: source.name,
            sourceId: source.id,
            providerMessageId: row.id,
            ...(row.thread_id === null || typeof row.thread_id === "string"
              ? { providerThreadId: row.thread_id }
              : {}),
            ...(row.campaign_id === null || typeof row.campaign_id === "string"
              ? { campaignId: row.campaign_id }
              : {}),
            ...(row.eaccount === null || typeof row.eaccount === "string"
              ? { eaccount: row.eaccount }
              : {}),
            savedRead,
            sender: row.from_address,
            recipients: row.to_address === null ? [] : [row.to_address],
            subject: row.subject ?? "",
            body: row.body_text ?? "",
            snippet: row.body_text === null,
            date: row.timestamp_email,
            url: null,
          });
          return message.success ? message.data : null;
        });
        if (messages.some((message) => message === null)) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        crmBinding ??= await recruiting.getRecruitingCrmTarget(prisma, actor, {
          runId: effect.run.id,
          roleId: workspace.role.id,
        });
        const bound = crmBinding.target;
        if (
          !bound ||
          !crmBinding.bindingEffectId ||
          bound.mcpServerId !== source.id ||
          bound.serverRevision !== source.revision ||
          call.args.p_org !== bound.organizationId ||
          typeof call.args.p_candidate !== "string"
        ) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        output.partial ||= call.args.p_cursor !== undefined || data.next_cursor !== null;
        if (!messages.length) {
          parsed = true;
          continue;
        }
        const membership = crmMemberships.get(
          stableJsonValue([source.id, call.args.p_org, call.args.p_candidate]),
        );
        if (membership) {
          // A newer explicit membership observation supersedes past imports, including empty/error.
          const result = byId.get(membership.effectId);
          const envelope = correspondenceRecord(result);
          const failed =
            membership.status === "failed" ||
            Boolean(
              envelope &&
                ("error" in envelope ||
                  ("isError" in envelope &&
                    envelope.isError !== false &&
                    envelope.isError !== undefined)),
            );
          const rows = mcpObject(result)?.data;
          if (
            !membership.readable ||
            failed ||
            !Array.isArray(rows) ||
            !rows.every((value) => {
              const row = correspondenceRecord(value);
              return (
                row?.organization_id === bound.organizationId &&
                row.candidate_id === call.args.p_candidate &&
                RecruitingCrmImportReceiptSchema.shape.membership_id.safeParse(row.membership_id)
                  .success &&
                typeof row.role_spec_id === "string" &&
                typeof row.client_id === "string"
              );
            }) ||
            !rows.some(
              (row) => row.role_spec_id === bound.crmRoleId && row.client_id === bound.crmClientId,
            )
          ) {
            checkIssue(source.id, membership.updatedAt, failed ? "failed" : "unsupported");
            continue;
          }
          parsed = true;
          for (const message of messages)
            if (message && !emails.has(message.id)) emails.set(message.id, message);
          continue;
        }
        if (retained.length > 200) {
          checkIssue(source.id, effect.updatedAt);
          continue; // Truncated history cannot establish absence of a membership observation.
        }
        // Only locate an exact import here; the single native batch below owns source verification.
        const link = await prisma.recruitingCrmImport.findFirst({
          where: {
            bindingEffectId: crmBinding.bindingEffectId,
            occurrence: { roleId: workspace.role.id },
            effect: {
              spaceId: actor.spaceId,
              status: "completed",
              run: { userId: actor.userId, spaceId: actor.spaceId },
              AND: [
                {
                  result: {
                    path: ["structuredContent", "data", "organization_id"],
                    equals: bound.organizationId,
                  },
                },
                {
                  result: {
                    path: ["structuredContent", "data", "candidate_id"],
                    equals: call.args.p_candidate,
                  },
                },
              ],
            },
          },
          orderBy: [{ effect: { createdAt: "desc" } }, { effectId: "desc" }],
          select: { effectId: true },
        });
        if (!link) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        crmPages.push({
          sourceId: source.id,
          updatedAt: effect.updatedAt,
          candidateId: call.args.p_candidate,
          importEffectId: link.effectId,
          messages: messages.filter((message) => message !== null),
        });
        continue;
      }
      if (provider.kind === "fullenrich" && body && call.route.toolName === FIND_EMAILS) {
        if (!Array.isArray(body.people)) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        parsed = true;
        for (const row of body.people) {
          const entry = correspondenceRecord(row);
          const linkedinUrl = entry?.linkedin_url;
          const identity =
            typeof linkedinUrl === "string" ? recruitingCalibrationIdentity(linkedinUrl) : null;
          if (!identity || !Array.isArray(entry?.emails) || !entry.emails.length) continue;
          const candidateKey = `linkedin:${identity}`;
          if (!candidateKeys.has(candidateKey) || contactKeys.has(candidateKey)) continue;
          const contact = RecruitingCorrespondenceSchema.shape.contacts.element.safeParse({
            candidateKey,
            linkedinUrl,
            emails: entry.emails.map((email) => {
              const value = correspondenceRecord(email);
              return { address: value?.address, status: value?.status ?? null };
            }),
            phones: [],
            source: source.name,
            checkedAt: effect.updatedAt.toISOString(),
          });
          if (!contact.success) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          contactKeys.add(candidateKey);
          output.contacts.push(contact.data);
        }
        continue;
      }
      if (provider.kind === "fullenrich" && body) {
        if (typeof call.args.enrichment_id !== "string" || !call.args.enrichment_id.trim()) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        if (body.status === "in_progress") {
          output.partial = true;
          continue;
        }
        if (body.status !== "FINISHED" || !Array.isArray(body.results)) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        parsed = true;
        for (const row of body.results) {
          const entry = correspondenceRecord(row);
          const input = correspondenceRecord(entry?.input);
          const profile = correspondenceRecord(entry?.profile);
          const network = correspondenceRecord(
            correspondenceRecord(profile?.social_profiles)?.professional_network,
          );
          const linkedinUrl = input?.professional_network_url;
          const identity =
            typeof linkedinUrl === "string" ? recruitingCalibrationIdentity(linkedinUrl) : null;
          const profileIdentity =
            typeof network?.url === "string" ? recruitingCalibrationIdentity(network.url) : null;
          if (!identity || identity !== profileIdentity) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          const candidateKey = `linkedin:${identity}`;
          if (!candidateKeys.has(candidateKey) || contactKeys.has(candidateKey)) continue;
          contactKeys.add(candidateKey);
          const info = correspondenceRecord(entry?.contact_info);
          if (!info || !Array.isArray(info.work_emails)) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          const addresses = [info.most_probable_work_email, ...info.work_emails]
            .filter((email) => email !== null && email !== undefined)
            .map((email) => {
              const value = correspondenceRecord(email);
              return { address: value?.email, status: value?.status };
            });
          const contact = RecruitingCorrespondenceSchema.shape.contacts.element.safeParse({
            candidateKey,
            linkedinUrl,
            emails: addresses,
            // ponytail: the observed provider phone is null; do not infer an unverified phone schema.
            phones: [],
            source: source.name,
            checkedAt: effect.updatedAt.toISOString(),
          });
          if (!contact.success) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          contact.data.emails = [
            ...new Map(contact.data.emails.map((email) => [email.address, email])).values(),
          ];
          output.contacts.push(contact.data);
        }
        continue;
      }
      if (provider.kind === "cal" && body) {
        if (body.status !== "success") {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        const availability = call.route.toolName === "get_availability";
        let rows: unknown[];
        if (availability) {
          const days = correspondenceRecord(body.data);
          if (!days) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          rows = Object.values(days).flatMap((slots) => {
            if (Array.isArray(slots)) return slots;
            checkIssue(source.id, effect.updatedAt);
            return [];
          });
        } else {
          rows = call.route.toolName === "get_booking" ? [body.data] : (body.data as unknown[]);
          if (!Array.isArray(rows)) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          if (call.route.toolName === "get_bookings") {
            const pagination = correspondenceRecord(body.pagination);
            output.partial ||=
              pagination?.hasNextPage !== false ||
              pagination.hasPreviousPage === true ||
              (typeof call.args.skip === "number" && call.args.skip > 0);
          }
        }
        parsed = true;
        for (const value of rows) {
          const row = correspondenceRecord(value);
          const start = availability && typeof value === "string" ? value : row?.start;
          const end = row?.end ?? null;
          if (
            !availability &&
            (typeof row?.uid !== "string" ||
              !row.uid.trim() ||
              (call.route.toolName === "get_booking" && row.uid !== call.args.bookingUid))
          ) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          if (
            !availability &&
            !bookingProofs.has(stableJsonValue([source.id, source.revision, row!.uid]))
          ) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          const id = availability
            ? stableJsonValue([
                source.id,
                "slot",
                ...calAvailabilitySubject(call.args),
                start ?? null,
                end,
              ])
            : `${source.id}:booking:${row!.uid}`;
          const location = availability ? null : (row?.location ?? null);
          const event = RecruitingCorrespondenceSchema.shape.events.element.safeParse({
            id,
            kind: availability ? "availability" : "event",
            title: availability ? null : (row?.title ?? null),
            start,
            end,
            timeZone: availability ? (call.args.timeZone ?? "UTC") : null,
            attendees: availability
              ? []
              : Array.isArray(row?.attendees)
                ? row.attendees.map(
                    (attendee) =>
                      correspondenceRecord(attendee)?.email ?? correspondenceRecord(attendee)?.name,
                  )
                : [],
            // Exact successful replacement lineage retires the old observation without claiming
            // that the provider cancelled it. Retain it as history, never as an upcoming booking.
            status: availability
              ? null
              : supersededBookings.has(stableJsonValue([source.id, source.revision, row!.uid]))
                ? "superseded"
                : (row?.status ?? null),
            location,
            url: typeof location === "string" && /^https?:\/\//u.test(location) ? location : null,
          });
          if (
            !event.success ||
            (!availability && !event.data.end) ||
            (event.data.end && Date.parse(event.data.end) <= Date.parse(event.data.start))
          ) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          if (!events.has(id)) events.set(id, event.data);
        }
        continue;
      }
      if (provider.kind === "gmail" && body) {
        // ponytail: selected native reads leave mailbox coverage and canonical role association unknown.
        output.partial = true;
        if (call.route.toolName === "search_threads") continue;
        const thread = call.route.toolName === "get_thread";
        const selectedId = thread ? call.args.threadId : call.args.messageId;
        if (typeof selectedId !== "string" || !selectedId.trim() || body.id !== selectedId) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        const rows = thread ? (body.messages === undefined ? [] : body.messages) : [body];
        if (!Array.isArray(rows)) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        const format = call.args.messageFormat;
        const full =
          format === undefined ||
          format === "MESSAGE_FORMAT_UNSPECIFIED" ||
          format === "FULL_CONTENT" ||
          format === "PLAIN_TEXT";
        parsed = true;
        for (const value of rows.toReversed()) {
          const row = correspondenceRecord(value);
          if (
            typeof row?.id !== "string" ||
            !row.id.trim() ||
            (thread && row.threadId !== undefined && row.threadId !== selectedId)
          ) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          const threadId = thread ? selectedId : row.threadId;
          const threadOwner =
            typeof threadId === "string" ? gmailThreads.get(`${source.id}:${threadId}`) : undefined;
          const id = `${source.id}:${row.id}`;
          const messageOwner = gmailMessages.get(id);
          if (
            (threadOwner && threadOwner !== effect.id) ||
            (messageOwner && messageOwner !== effect.id)
          )
            continue;
          gmailMessages.set(id, effect.id);
          const plain = full ? row.plaintextBody : undefined;
          const text =
            typeof plain === "string" ? plain : typeof row.snippet === "string" ? row.snippet : "";
          const message = RecruitingCorrespondenceSchema.shape.emails.element.safeParse({
            id,
            sourceName: source.name,
            sourceId: source.id,
            providerMessageId: row.id,
            savedRead,
            ...(typeof threadId === "string" ? { providerThreadId: threadId } : {}),
            sender: row.sender ?? null,
            recipients: row.toRecipients ?? [],
            subject: row.subject ?? "",
            body: text.slice(0, 50_000),
            snippet: typeof plain !== "string" || text.length > 50_000,
            date: row.date ?? null,
            url: row.viewUrl ?? null,
          });
          if (!message.success) {
            checkIssue(source.id, effect.updatedAt);
            continue;
          }
          if (!emails.has(message.data.id)) emails.set(message.data.id, message.data);
        }
        continue;
      }
      if (provider.kind !== "instantly" || !body) {
        checkIssue(source.id, effect.updatedAt);
        continue;
      }
      // Native reads (thread history, contact and mailbox pages) return the raw REST page, which the
      // connector already verified against the requested thread/contact/mailbox scope.
      const native = isNativeInstantlyRead(call.route.toolName);
      const page = native ? correspondenceRecord(body.page) : body;
      const listRead =
        call.route.toolName === "list_emails" || (native && page?.items !== undefined);
      const rows = listRead ? page?.items : native ? [correspondenceRecord(body.result)] : [body];
      if (!Array.isArray(rows)) {
        checkIssue(source.id, effect.updatedAt);
        continue;
      }
      if (listRead) {
        parsed = true;
        output.partial ||=
          call.args.starting_after !== undefined &&
          call.args.starting_after !== null &&
          call.args.starting_after !== "";
      }
      output.partial ||=
        page?.next_starting_after !== undefined &&
        page?.next_starting_after !== null &&
        page?.next_starting_after !== "";
      for (const row of rows) {
        const email = readInstantlyEmail(row);
        if (!email) {
          checkIssue(source.id, effect.updatedAt);
          output.partial = true;
          continue;
        }
        const id = `${source.id}:${email.id}`;
        if (!listRead && email.id !== call.args.id) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        if (
          !campaignRead({ effect, call, source, provider }) &&
          revived(source.id, email.campaign_id, email.id, effect.updatedAt)
        ) {
          output.partial = true;
          continue;
        }
        if (call.route.toolName === "list_emails" && typeof call.args.campaign_id === "string")
          campaignLists.get(`${source.id}:${call.args.campaign_id}`)?.ids.add(email.id);
        // A campaign-scoped list must only return that campaign; contact/thread reads and
        // non-campaign Unibox mail (direct replies, off-sequence mail) have no campaign to verify.
        if (
          call.route.toolName === "list_emails" &&
          typeof call.args.campaign_id === "string" &&
          email.campaign_id &&
          email.campaign_id !== call.args.campaign_id
        ) {
          checkIssue(source.id, effect.updatedAt);
          continue;
        }
        parsed = true;
        const observedAt = instantlyObservedAt.get(id);
        if (listRead && observedAt && observedAt >= effect.updatedAt) continue;
        instantlyObservedAt.set(id, effect.updatedAt);
        const fullText =
          email.body.text || (email.body.html ? htmlToPlainText(email.body.html) : "");
        const text = fullText || email.content_preview || "";
        const displayText =
          call.route.toolName === "list_emails"
            ? text.replace(/\[truncated — use get_email for full content\](\s*)$/u, "$1")
            : text;
        output.partial ||= email.body_fallback_reason != null;
        emails.set(id, {
          id,
          sourceName: source.name,
          sourceId: source.id,
          providerMessageId: email.id,
          ...instantlyEmailObservation(email, effect.updatedAt),
          ...(email.thread_id !== undefined ? { providerThreadId: email.thread_id } : {}),
          ...(email.campaign_id !== undefined ? { campaignId: email.campaign_id } : {}),
          ...(email.eaccount !== undefined ? { eaccount: email.eaccount } : {}),
          savedRead,
          sender: email.from_address_email ?? null,
          recipients: email.to_address_email_list ? [email.to_address_email_list] : [],
          subject: email.subject,
          body: displayText.slice(0, 50_000),
          snippet:
            (listRead && !native) ||
            email.body_fallback_reason != null ||
            !fullText ||
            text.length > 50_000,
          date: email.timestamp_email,
          url: null,
        });
      }
    }
    if (crmPages.length) {
      const bound = crmBinding?.target;
      if (!bound) throw new IsolationError();
      const imports = new Map(
        (
          await recruiting.getRecruitingCrmCandidateSyncs(prisma, actor, {
            roleId: workspace.role.id,
            effectIds: [...new Set(crmPages.map((page) => page.importEffectId))],
          })
        ).map((sync) => [sync.effectId, sync]),
      );
      for (const page of crmPages) {
        const imported = imports.get(page.importEffectId);
        if (
          imported?.status !== "synced" ||
          imported.bindingEffectId !== crmBinding?.bindingEffectId ||
          stableJsonValue(imported.target) !== stableJsonValue(bound) ||
          imported.receipt?.organization_id !== bound.organizationId ||
          imported.receipt.candidate_id !== page.candidateId
        ) {
          checkIssue(page.sourceId, page.updatedAt);
          continue;
        }
        parsed = true;
        for (const message of page.messages)
          if (!emails.has(message.id)) emails.set(message.id, message);
      }
    }
    output.emails = [...emails.values()];
    // ponytail: bound retained calendar display to 200 entries; full receipts remain in native history.
    output.events = [...events.values()].slice(0, 200);
    output.partial ||= events.size > 200 || unsupported || failed;
    output.status =
      output.emails.length || output.events.length || output.contacts.length
        ? "ready"
        : failed
          ? "failed"
          : unsupported
            ? "unsupported"
            : parsed
              ? "empty"
              : "not_checked";
    // A late role switch cannot carry a previous role's saved mail into the new workspace.
    const current = await prisma.thread.findFirst({
      where: {
        id: target.threadId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        activeRecruitingRoleId: workspace.role.id,
        ...(crmBinding
          ? { activeRecruitingRole: { crmBindingEffectId: crmBinding.bindingEffectId } }
          : {}),
      },
      select: { id: true },
    });
    if (!current) throw new IsolationError();
    return finish();
  });
}

/** Bind exact UTF-16 quotes in MCP array text to one canonical saved person. */
function selectedProviderRow(
  bytes: Uint8Array,
  text: string,
  selection: RecruitingSourceSelection | undefined,
) {
  if (selection?.kind !== "artifact_json_string") throw new IsolationError();
  const { path, start, end } = selection;
  const rowPaths = [
    ["providerResult", "structuredContent", "rows"],
    ["observation", "rows"],
  ];
  const rowPath = rowPaths.find((prefix) => prefix.every((key, index) => path[index] === key));
  if (rowPath) {
    const rowIndex = path[rowPath.length];
    if (typeof rowIndex !== "number" || !Number.isSafeInteger(rowIndex) || rowIndex < 0)
      throw new IsolationError();
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(original);
    const node = findNodeAtLocation(parseTree(original)!, [...rowPath, rowIndex]);
    if (node?.type !== "object") throw new IsolationError();
    return {
      rowIndex,
      row: JSON.parse(original.slice(node.offset, node.offset + node.length)) as Record<
        string,
        unknown
      >,
    };
  }
  if (
    path.length !== 4 ||
    path[0] !== "providerResult" ||
    path[1] !== "content" ||
    typeof path[2] !== "number" ||
    path[3] !== "text"
  )
    throw new IsolationError();
  JSON.parse(text);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const rows = root?.type === "array" ? root : root && findNodeAtLocation(root, ["rows"]);
  if (errors.length || rows?.type !== "array" || !rows.children) throw new IsolationError();
  const overlapping = rows.children.filter(
    (node) => start < node.offset + node.length && end > node.offset,
  );
  const node = overlapping[0];
  if (overlapping.length !== 1 || !node || node.type !== "object") throw new IsolationError();
  const surrounding =
    text.slice(start, Math.min(end, node.offset)) +
    text.slice(Math.max(start, node.offset + node.length), end);
  if (!/^[\s[\],]*$/.test(surrounding)) throw new IsolationError();
  return {
    rowIndex: rows.children.indexOf(node),
    row: JSON.parse(text.slice(node.offset, node.offset + node.length)) as Record<string, unknown>,
  };
}

function sameReportedRow(selected: Record<string, unknown>, canonical: unknown) {
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return false;
  const value = (cell: unknown) =>
    cell && typeof cell === "object" && !Array.isArray(cell) && Object.hasOwn(cell, "value")
      ? (cell as { value: unknown }).value
      : cell;
  const keys = Object.keys(selected).filter(isRecruitingCandidateReportField);
  return (
    keys.length > 0 &&
    keys.length === Object.keys(canonical).filter(isRecruitingCandidateReportField).length &&
    keys.every(
      (key) =>
        Object.hasOwn(canonical, key) &&
        isDeepStrictEqual(value(selected[key]), value((canonical as Record<string, unknown>)[key])),
    )
  );
}

export const readRecruitingSource = (
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  input: ReadRecruitingSourceInput,
) =>
  authenticated(async () => {
    let sources: readonly (RecruitingSourceRef | RecruitingAssessmentSourceRef)[];
    if (input.kind === "role") {
      const workspace = await recruiting.getRecruitingWorkspace(deps.prisma, actor, {
        threadId: input.threadId,
      });
      if (!workspace || workspace.revision.id !== input.roleRevisionId) throw new IsolationError();
      sources = [
        ...workspace.revision.sourceRefs,
        ...workspace.revision.criteria.flatMap((criterion) => criterion.sourceRefs),
      ];
    } else {
      const snapshot = await recruiting.getRecruitingAssessment(deps.prisma, actor, {
        roleId: input.roleId,
        candidateKey: input.candidateKey,
        version: input.version,
      });
      if (!snapshot || snapshot.assessment.version !== input.version) throw new IsolationError();
      sources = snapshot.assessment.sourceRefs;
    }
    const matches = sources.filter((source) => source.id === input.sourceRefId);
    const source = matches[0];
    if (
      !source ||
      matches.some((value) => !isDeepStrictEqual(value, source)) ||
      source.readState !== "read" ||
      !source.quote ||
      source.anchor.kind !== "artifact"
    )
      throw new IsolationError();
    try {
      const { row, bytes } = await readActorArtifact(deps, actor, {
        artifactId: source.anchor.artifact.artifactId,
      });
      if (row.hash !== source.anchor.artifact.sha256) throw new IsolationError();
      const selection = "selection" in source ? source.selection : undefined;
      // ponytail: role sources attest only extracted text; other strings require the stored typed path.
      if (selection?.kind === "message_text" || (!selection && source.anchor.locator !== "text"))
        throw new IsolationError();
      const json = row.mimeType === "application/json" || row.mimeType.endsWith("+json");
      const pdf = row.mimeType === "application/pdf";
      const path =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (path ? !json : (!row.mimeType.startsWith("text/") && !pdf) || json)
        throw new IsolationError();
      const text = path
        ? readRecruitingJsonString(bytes, path)
        : pdf
          ? await extractPdfText(bytes)
          : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const start = selection?.start ?? text.indexOf(source.quote);
      const end = selection?.end ?? start + source.quote.length;
      validateRecruitingTextSelection(text, start, end, source.quote);
      if (input.kind === "assessment" && source.kind === "provider_report" && json) {
        const selected = selectedProviderRow(bytes, text, selection);
        const readReport = createRecruitingCandidateReportReader(deps, actor, input.roleId, {
          artifacts: new Map([[row.id, { row, bytes }]]),
        });
        // ponytail: use existing occurrence pagination; add an artifact selector only if histories grow large.
        const matches: RecruitingCandidateSource[] = [];
        let cursor: string | undefined;
        do {
          const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, {
            roleId: input.roleId,
            candidateKey: input.candidateKey,
            ...(cursor ? { cursor } : {}),
          });
          matches.push(
            ...page.items.filter(
              (item) =>
                item.artifactRef.artifactId === row.id &&
                item.artifactRef.sha256 === row.hash &&
                item.rowIndex === selected.rowIndex,
            ),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (matches.length !== 1) throw new IsolationError();
        const retained = await readReport(matches[0]!);
        if (!sameReportedRow(selected.row, retained.row)) throw new IsolationError();
        return { kind: "report" as const, report: retained.report };
      }
      return { kind: "text" as const, text, start, end };
    } catch {
      throw new IsolationError();
    }
  });

export const createRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.createRecruitingRole(prisma, actor, input, material));
export const bindRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.bindRecruitingRole>[2],
) => authenticated(() => recruiting.bindRecruitingRole(prisma, actor, input));
export const getRecruitingWorkspace = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingWorkspace>[2],
) => authenticated(() => recruiting.getRecruitingWorkspace(prisma, actor, input));
export const reviseRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.reviseRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.reviseRecruitingRole(prisma, actor, input, material));
export const archiveRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.setRecruitingRoleArchived>[2],
) => authenticated(() => recruiting.setRecruitingRoleArchived(prisma, actor, input));
export const listRecruitingAssessments = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingAssessments>[2],
) => authenticated(() => recruiting.listRecruitingAssessments(prisma, actor, input));
export const listRecruitingFeedback = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingFeedback>[2],
) => authenticated(() => recruiting.listRecruitingFeedback(prisma, actor, input));
export const getRecruitingAssessment = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingAssessment>[2],
) => authenticated(() => recruiting.getRecruitingAssessment(prisma, actor, input));
export const listRecruitingResearch = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingResearch>[2],
) => authenticated(() => recruiting.listRecruitingResearch(prisma, actor, input));

export const listRecruitingQuestions = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingQuestions>[2],
) =>
  authenticated(async () => ({
    questions: await recruiting.listRecruitingQuestions(prisma, actor, input),
  }));

export const confirmRecruitingBrief = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.confirmRecruitingBrief>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.confirmRecruitingBrief(prisma, actor, input, material));

export const editRecruitingCriteria = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.editRecruitingCriteria>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.editRecruitingCriteria(prisma, actor, input, material));

async function hydrateRecruitingCandidateReports(
  deps: RecruitingReadDeps,
  actor: Actor,
  roleId: string,
  sources: Omit<RecruitingCandidateSource, "crmImports">[],
) {
  const artifacts = new Map<string, Awaited<ReturnType<typeof readActorArtifact>>>();
  const readReport = createRecruitingCandidateReportReader(deps, actor, roleId, { artifacts });
  const byArtifact = new Map<string, typeof sources>();
  for (const source of sources) {
    const group = byArtifact.get(source.artifactRef.artifactId) ?? [];
    group.push(source);
    byArtifact.set(source.artifactRef.artifactId, group);
  }
  const groups = [...byArtifact.values()];
  // ponytail: bound parallel multi-MB reads to four pages; tune only after measured storage capacity.
  for (let start = 0; start < groups.length; start += 4) {
    await Promise.all(
      groups.slice(start, start + 4).map(async (group) => {
        for (const source of group) delete source.report;
        const artifactId = group[0]!.artifactRef.artifactId;
        try {
          artifacts.set(artifactId, await readActorArtifact(deps, actor, { artifactId }));
        } catch {
          return;
        }
        for (const source of group) {
          try {
            source.report = (await readReport(source)).report;
          } catch {
            // Authorized provenance remains readable when its report bytes are unavailable.
          }
        }
      }),
    );
  }
}

export const listRecruitingCandidates = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidates>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidates(deps.prisma, actor, input);
    await hydrateRecruitingCandidateReports(
      deps,
      actor,
      input.roleId,
      page.items.flatMap((candidate) => (candidate.latestSource ? [candidate.latestSource] : [])),
    );
    return page;
  });
export const listRecruitingCandidateSources = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidateSources>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, input);
    await hydrateRecruitingCandidateReports(deps, actor, input.roleId, page.items);
    return page;
  });
export const setRecruitingCandidateShortlist = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.setRecruitingCandidateShortlist>[2],
) => authenticated(() => recruiting.setRecruitingCandidateShortlist(prisma, actor, input));

function mailItem(row: ReturnType<typeof RecruitingCrmMailReadSchema.parse>["messages"][number]) {
  return {
    id: row.id,
    providerMessageId: row.id,
    threadId: row.thread_id,
    campaignId: row.campaign_id,
    direction: row.direction,
    sender: row.from_address,
    recipients: row.to_address === null ? [] : [row.to_address],
    subject: row.subject,
    body: row.body_text,
    date: row.timestamp_email,
    partial: row.body_text === null,
  };
}

/** Live read-only CRM view. The CRM remains the store; browsing creates no agent work. */
export type RecruitingCrmReadDeps = {
  prisma: PrismaClient;
  connectors: Pick<ConnectorProvider, "execute">;
  firstPartyMcpUrl?: string;
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
  reauthorize: () => Promise<ThreadTarget>;
};
type RecruitingCrmRoleLookup = { operation: "role"; reference: RecruitingCrmRoleReference };
export function getRecruitingCrmData(
  deps: RecruitingCrmReadDeps,
  actor: Actor,
  target: ThreadTarget,
  raw: RecruitingCrmDataInput,
  options?: { source: "projection" },
): Promise<RecruitingCrmDataOutput>;
export function getRecruitingCrmData(
  deps: RecruitingCrmReadDeps,
  actor: Actor,
  target: ThreadTarget,
  raw: RecruitingCrmRoleLookup,
): Promise<ReturnType<typeof RecruitingCrmRoleReadSchema.parse>>;
export async function getRecruitingCrmData(
  deps: RecruitingCrmReadDeps,
  actor: Actor,
  target: ThreadTarget,
  raw: RecruitingCrmDataInput | RecruitingCrmRoleLookup,
  options?: { source: "projection" },
): Promise<RecruitingCrmDataOutput | ReturnType<typeof RecruitingCrmRoleReadSchema.parse>> {
  return authenticated(async () => {
    const input =
      raw.operation === "role"
        ? {
            operation: "role" as const,
            ...RecruitingCrmRoleReferenceSchema.parse(raw.reference),
            serverId: raw.reference.sourceId,
          }
        : RecruitingCrmDataInputSchema.parse(raw);
    const signal = deps.signal ?? AbortSignal.timeout(30_000);
    const coordinator = (value: ThreadTarget) =>
      value.kind === "bot" ? value.botId : value.memberBotIds[0];
    const targetKey = (value: ThreadTarget) =>
      stableJsonValue(
        value.kind === "bot"
          ? [value.kind, value.threadId, value.botId]
          : [value.kind, value.threadId, value.groupId, value.memberBotIds],
      );
    const botId = coordinator(target);
    const targetScope = targetKey(target);
    if (!botId || !deps.firstPartyMcpUrl) throw new IsolationError();
    const context: AdapterContext = {
      operationId: randomUUID(),
      traceId: randomUUID(),
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId,
      signal,
    };
    const serverSelect = {
      id: true,
      name: true,
      revision: true,
      endpoint: true,
      transport: true,
      enabled: true,
      secretId: true,
      userId: true,
      spaceId: true,
    } as const;
    type Server = {
      id: string;
      name: string;
      revision: number;
      endpoint: string | null;
      transport: string;
      enabled: boolean;
      secretId: string | null;
      userId: string;
      spaceId: string;
    };
    const allowed = (
      assignment: { allowAllTools: boolean; allowedTools: unknown } | null,
      tool: string,
    ) =>
      assignment &&
      (assignment.allowAllTools ||
        (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(tool)));
    // Authorization lookups are memoized inside this one request only, never across requests.
    // Every provider read or native capture invalidates them, so the fence after it is fresh;
    // only back-to-back checks with no read in between share one lookup.
    let actorChecked: Promise<void> | undefined;
    const invalidateFences = () => {
      actorChecked = undefined;
      grants.clear();
    };
    const actorFence = () => {
      signal.throwIfAborted();
      actorChecked ??= (async () => {
        if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
        const freshActor = await recruiting.requireMembership(
          deps.prisma,
          actor.userId,
          actor.spaceId,
        );
        if (
          freshActor.userId !== actor.userId ||
          freshActor.spaceId !== actor.spaceId ||
          targetKey(await deps.reauthorize()) !== targetScope
        )
          throw new IsolationError();
      })();
      return actorChecked;
    };
    const grants = new Map<
      string,
      Promise<[Server | null, { allowAllTools: boolean; allowedTools: unknown } | null]>
    >();
    const serverGrant = (serverId: string) => {
      let grant = grants.get(serverId);
      if (!grant) {
        grant = Promise.all([
          deps.prisma.mcpServer.findFirst({
            where: { id: serverId, userId: actor.userId, spaceId: actor.spaceId },
            select: serverSelect,
          }),
          deps.prisma.botMcpServer.findFirst({
            where: { serverId, botId, userId: actor.userId, spaceId: actor.spaceId },
          }),
        ]);
        grants.set(serverId, grant);
      }
      return grant;
    };
    const sourceFence = async (server: Server, tool: string) => {
      await actorFence();
      const [current, assignment] = await serverGrant(server.id);
      if (
        !current?.enabled ||
        current.userId !== actor.userId ||
        current.spaceId !== actor.spaceId ||
        current.id !== server.id ||
        // Native account changes advance revision; quiet refresh only rotates secret records.
        current.revision !== server.revision ||
        (current.secretId === null) !== (server.secretId === null) ||
        current.endpoint !== deps.firstPartyMcpUrl ||
        current.endpoint !== server.endpoint ||
        current.transport !== "streamable_http" ||
        !allowed(assignment, tool)
      )
        throw new IsolationError();
      signal.throwIfAborted();
    };
    const unavailable = () =>
      new ORPCError("SERVICE_UNAVAILABLE", {
        message: "CRM records could not be loaded. Try again.",
      });
    const parse = <T>(
      schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
      value: unknown,
    ): T => {
      const result = schema.safeParse(value);
      if (!result.success) throw unavailable();
      return result.data;
    };
    async function read(server: Server, tool: string, args: Record<string, unknown>) {
      await sourceFence(server, tool);
      const results: unknown[] = [];
      let failed = false;
      try {
        for await (const event of deps.connectors.execute(
          {
            tool,
            route: {
              connectorId: "mcp",
              resourceId: server.id,
              resourceRevision: server.revision,
              toolName: tool,
            },
            args,
            executionId: randomUUID(),
          },
          context,
        )) {
          if (event.type === "result") results.push(event.data);
          if (event.type === "error") {
            failed = true;
          }
        }
      } catch {
        failed = true;
      }
      invalidateFences();
      await sourceFence(server, tool);
      const result = correspondenceRecord(results[0]);
      const payload = mcpObject(result);
      if (
        failed ||
        results.length !== 1 ||
        !result ||
        "error" in result ||
        (result.isError !== undefined && result.isError !== false) ||
        !payload ||
        !("data" in payload)
      )
        throw unavailable();
      return payload.data;
    }
    const memberships = new Map<
      string,
      Promise<ReturnType<typeof RecruitingCrmMembershipRowsSchema.parse>>
    >();
    const membershipRows = (server: Server) => {
      let rows = memberships.get(server.id);
      if (!rows) {
        rows = read(server, "list_crm_memberships", {}).then((value) =>
          parse(RecruitingCrmMembershipRowsSchema, value),
        );
        memberships.set(server.id, rows);
      }
      return rows;
    };
    const where = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      endpoint: deps.firstPartyMcpUrl,
      transport: "streamable_http",
      enabled: true,
    };
    await actorFence();
    if (input.operation === "memberships") {
      const servers = await deps.prisma.mcpServer.findMany({
        where: { ...where, ...(input.serverId ? { id: input.serverId } : {}) },
        select: {
          ...serverSelect,
          assignments: {
            where: { botId, userId: actor.userId, spaceId: actor.spaceId },
            select: { allowAllTools: true, allowedTools: true },
          },
        },
        orderBy: { id: "asc" },
      });
      const sources = [];
      const pinnedSources = [];
      for (const row of servers) {
        const server = { ...row };
        if (
          server.userId !== actor.userId ||
          server.spaceId !== actor.spaceId ||
          server.endpoint !== deps.firstPartyMcpUrl ||
          !server.enabled ||
          server.transport !== "streamable_http"
        )
          throw new IsolationError();
        if (
          input.serverId &&
          (server.id !== input.serverId || server.revision !== input.serverRevision)
        )
          throw new IsolationError();
        if (!server.assignments.some((assignment) => allowed(assignment, "list_crm_memberships")))
          continue;
        pinnedSources.push(server);
        try {
          const rows = await membershipRows(server);
          sources.push({
            serverId: server.id,
            serverRevision: server.revision,
            name: server.name,
            status: "ready" as const,
            memberships: rows.map((row) => ({
              organizationId: row.organization_id,
              name: row.organizations?.name ?? null,
              role: row.role,
            })),
          });
        } catch (error) {
          if (!(error instanceof ORPCError) || error.code !== "SERVICE_UNAVAILABLE") throw error;
          sources.push({
            serverId: server.id,
            serverRevision: server.revision,
            name: server.name,
            status: "unavailable" as const,
            memberships: [],
          });
        }
      }
      if (input.serverId && !sources.length) throw new IsolationError();
      for (const source of pinnedSources) await sourceFence(source, "list_crm_memberships");
      return RecruitingCrmDataOutputSchema.parse({
        operation: input.operation,
        checkedAt: new Date().toISOString(),
        sources,
      });
    }
    const selectedServer = await deps.prisma.mcpServer.findFirst({
      where: { ...where, id: input.serverId },
      select: serverSelect,
    });
    if (
      !selectedServer ||
      selectedServer.id !== input.serverId ||
      selectedServer.revision !== input.serverRevision
    )
      throw new IsolationError();
    const server = { ...selectedServer };
    // Required mail access must fail before even the organization-membership provider read.
    if (input.operation === "roleMail" || (input.operation === "mail" && input.crmRoleId))
      await sourceFence(server, "list_crm_role_correspondence");
    if (!(await membershipRows(server)).some((row) => row.organization_id === input.organizationId))
      throw new IsolationError();
    const source = {
      serverId: server.id,
      serverRevision: server.revision,
      name: server.name,
      organizationId: input.organizationId,
    };
    if (input.operation === "role") {
      const role = parse(
        RecruitingCrmRoleReadSchema,
        await read(server, "get_crm_role", {
          p_org: input.organizationId,
          p_role: input.crmRoleId,
        }),
      );
      if (role.role_spec_id !== input.crmRoleId) throw unavailable();
      await sourceFence(server, "get_crm_role");
      return role;
    }
    const roles = async () =>
      parse(
        RecruitingCrmClientsReadSchema,
        await read(server, "list_crm_roles", { p_org: input.organizationId }),
      ).flatMap((client) =>
        client.roles.map((role) => ({
          crmRoleId: role.role_spec_id,
          clientId: client.client_id,
          clientLabel: client.client_label,
          roleLabel: role.role_label,
          summary: role.summary,
        })),
      );
    const finish = (value: Record<string, unknown>) =>
      RecruitingCrmDataOutputSchema.parse({
        ...value,
        // Offset-backed pages also expose the next offset as the opaque `cursor` callers pass back.
        ...("nextOffset" in value
          ? { nextCursor: value.nextOffset === null ? null : String(value.nextOffset) }
          : {}),
        source,
        checkedAt: new Date().toISOString(),
      });
    const pageOffset = (page: { offset?: number; cursor?: string }) => {
      if (
        page.cursor !== undefined &&
        page.offset !== undefined &&
        Number(page.cursor) !== page.offset
      )
        throw new ORPCError("BAD_REQUEST", { message: "Pass either offset or cursor." });
      return page.cursor !== undefined ? Number(page.cursor) : (page.offset ?? 0);
    };
    const candidate = (
      row: ReturnType<typeof RecruitingCrmCandidatesReadSchema.parse>["rows"][number],
    ) => ({
      candidateId: row.candidate_id,
      name: row.full_name,
      email: row.email,
      phone: row.phone,
      linkedinUrl: row.linkedin_url,
      location: row.location ?? null,
      title: row.headline ?? null,
      stage: row.stage,
      contactStatus: row.contact_status,
      outreachStatus: row.outreach_status,
      roleSpecId: row.role_spec_id,
      legacyClientLabel: row.client_label,
      legacyRoleLabel: row.role_label,
      ...(row.interest !== undefined ? { interest: row.interest } : {}),
      ...(row.reviewed !== undefined ? { reviewed: row.reviewed } : {}),
      ...(row.last_reply_at !== undefined ? { lastReplyAt: row.last_reply_at } : {}),
      ...(row.resume_received !== undefined ? { resumeReceived: row.resume_received } : {}),
      ...(row.company !== undefined ? { company: row.company } : {}),
      ...(row.profile !== undefined ? { profile: row.profile } : {}),
    });
    const tracking = (
      row: Omit<
        ReturnType<typeof RecruitingCrmDetailsReadSchema.parse>["role_tracking"][number],
        "candidate_id"
      >,
    ) => ({
      roleKey: row.role_key,
      clientLabel: row.client_label,
      roleLabel: row.role_label,
      highSignal: row.high_signal,
      workflowStatus: row.workflow_status,
      highSignalAt: row.high_signal_at,
      statusChangedAt: row.status_changed_at,
      updatedAt: row.updated_at,
    });
    const outbox = async (candidateId: string) => {
      const rows = parse(
        RecruitingCrmMessagesReadSchema,
        await read(server, "list_crm_candidate_messages", {
          p_org: input.organizationId,
          p_candidate: candidateId,
        }),
      );
      if (
        rows.some(
          (row) => row.organization_id !== input.organizationId || row.candidate_id !== candidateId,
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        throw unavailable();
      return rows.map((row) => ({
        id: row.id,
        body: row.body,
        status: row.status,
        polishedBody: row.polished_body,
        providerMessageId: row.instantly_email_id,
        error: row.error,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      }));
    };
    if (input.operation === "important") {
      const offset = pageOffset(input);
      const limit = input.limit ?? 25;
      const page = parse(
        RecruitingCrmImportantReadSchema,
        await read(server, "list_crm_candidates", {
          p_view: "important",
          p_org: input.organizationId,
          p_limit: limit,
          p_offset: offset,
          ...(input.status ? { p_status: input.status } : {}),
        }),
      );
      const keys = page.rows.map((row) =>
        JSON.stringify([row.candidate_id, row.role_tracking[0].role_key]),
      );
      if (
        page.rows.length > limit ||
        (page.rows.length && offset + page.rows.length > page.total) ||
        new Set(keys).size !== keys.length ||
        page.rows.some(
          (row) =>
            !row.role_tracking[0].high_signal && row.role_tracking[0].workflow_status === null,
        )
      )
        throw unavailable();
      return finish({
        operation: input.operation,
        scope: "organization_candidate_roles",
        items: page.rows.map((row) => ({
          ...candidate(row),
          ...tracking({
            ...row.role_tracking[0],
            client_label: row.client_label,
            role_label: row.role_label,
          }),
        })),
        total: page.total,
        offset,
        nextOffset:
          page.rows.length && offset + page.rows.length < page.total
            ? offset + page.rows.length
            : null,
      });
    }
    if (input.operation === "candidateDetails") {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 25;
      // Independent reads behind the same membership gate; each keeps its own fences.
      const [messages, page] = await Promise.all([
        outbox(input.candidateId),
        read(server, "get_crm_candidate_review", {
          p_view: "details",
          p_org: input.organizationId,
          p_candidate: input.candidateId,
          p_campaign_limit: limit,
          p_campaign_offset: offset,
        }).then((value) => parse(RecruitingCrmDetailsReadSchema, value)),
      ]);
      const associations = page.campaign_associations;
      if (
        page.organization_id !== input.organizationId ||
        page.candidate_id !== input.candidateId ||
        (page.review &&
          (page.review.organization_id !== input.organizationId ||
            page.review.candidate_id !== input.candidateId)) ||
        page.role_tracking.some((row) => row.candidate_id !== input.candidateId) ||
        new Set(page.role_tracking.map((row) => row.role_key)).size !== page.role_tracking.length ||
        new Set(page.role_interests.map((row) => row.role_key)).size !==
          page.role_interests.length ||
        associations.lead_campaigns.length > limit ||
        associations.offset !== offset ||
        new Set(associations.lead_campaigns.map((row) => row.lead_id)).size !==
          associations.lead_campaigns.length ||
        associations.lead_campaigns.some(
          (row) => row.campaign && row.campaign.id !== row.campaign_id,
        ) ||
        (associations.next_offset !== null &&
          (!associations.lead_campaigns.length ||
            associations.next_offset !== offset + associations.lead_campaigns.length))
      )
        throw unavailable();
      const campaign = (row: typeof associations.pipeline_campaign) =>
        row && {
          id: row.id,
          name: row.name,
          status: row.status,
          crmRoleId: row.role_spec_id,
          clientId: row.client_id,
          syncedAt: row.synced_at,
        };
      await sourceFence(server, "list_crm_candidate_messages");
      return finish({
        operation: input.operation,
        scope: "stored_candidate_details",
        outbox: messages,
        candidateId: input.candidateId,
        review: page.review && {
          id: page.review.id,
          crmRoleId: page.review.role_spec_id,
          stage: page.review.stage,
          reviewed: page.review.reviewed,
          result: page.review.review_result,
          notes: page.review.notes,
          updatedAt: page.review.updated_at,
          candidateName: page.review.candidate_full_name,
          roleTitle: page.review.canonical_role_title,
        },
        roleTracking: page.role_tracking.map(tracking),
        roleInterests: page.role_interests.map((row) => ({
          roleKey: row.role_key,
          clientLabel: row.client_label,
          roleLabel: row.role_label,
          interest: row.interest,
          source: row.source,
        })),
        campaignAssociations: {
          leadCampaigns: associations.lead_campaigns.map((row) => ({
            leadId: row.lead_id,
            campaignId: row.campaign_id,
            campaign: campaign(row.campaign),
          })),
          pipelineCampaign: campaign(associations.pipeline_campaign),
          offset,
          nextOffset: associations.next_offset,
        },
      });
    }
    if (input.operation === "roleCampaigns") {
      const offset = pageOffset(input);
      const limit = input.limit ?? 25;
      const page = parse(
        RecruitingCrmRoleCampaignsReadSchema,
        await read(server, "get_crm_role", {
          p_view: "campaigns",
          p_org: input.organizationId,
          p_role: input.crmRoleId,
          p_limit: limit,
          p_offset: offset,
        }),
      );
      if (
        page.organization_id !== input.organizationId ||
        page.role_spec_id !== input.crmRoleId ||
        page.campaigns.length > limit ||
        page.offset !== offset ||
        new Set(page.campaigns.map((row) => row.id)).size !== page.campaigns.length ||
        (page.next_offset !== null &&
          (!page.campaigns.length || page.next_offset !== offset + page.campaigns.length))
      )
        throw unavailable();
      return finish({
        operation: input.operation,
        scope: "stored_role_campaigns",
        crmRoleId: input.crmRoleId,
        items: page.campaigns.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          syncedAt: row.synced_at,
        })),
        offset,
        nextOffset: page.next_offset,
      });
    }
    if (input.operation === "roles")
      return finish({ operation: input.operation, items: await roles() });
    if (input.operation === "roleMail") {
      const offset = pageOffset(input);
      const limit = input.limit ?? 25;
      const done = (items: unknown[], nextOffset: number | null) =>
        finish({
          operation: input.operation,
          scope: "stored_role_correspondence",
          crmRoleId: input.crmRoleId,
          supported: true,
          items,
          offset,
          nextOffset,
        });
      const value = await read(server, "list_crm_role_correspondence", {
        p_org: input.organizationId,
        p_role: input.crmRoleId,
        p_limit: limit,
        p_offset: offset,
      });
      const page = parse(RecruitingCrmRoleMailReadSchema, value);
      if (
        page.organization_id !== input.organizationId ||
        page.role_id !== input.crmRoleId ||
        page.candidate_id != null ||
        page.messages.length > limit ||
        page.messages.some((row) => row.organization_id !== input.organizationId) ||
        new Set(page.messages.map((row) => row.id)).size !== page.messages.length ||
        (page.next_offset !== null && page.next_offset <= offset)
      )
        throw unavailable();
      await sourceFence(server, "list_crm_role_correspondence");
      return done(
        page.messages.map((row) => ({
          ...mailItem(row),
          candidateId: row.candidate_id,
          ...(row.eaccount !== undefined ? { eaccount: row.eaccount } : {}),
        })),
        page.next_offset,
      );
    }
    if (input.operation === "sequenceStats") {
      const candidateIds = [...new Set(input.candidateIds)];
      const page = parse(
        RecruitingCrmPersonLeadsReadSchema,
        await read(server, "list_crm_campaigns", {
          p_org: input.organizationId,
          p_view: "person_leads",
          p_candidates: candidateIds,
        }),
      );
      if (
        page.organization_id !== input.organizationId ||
        page.leads.some((row) => !candidateIds.includes(row.candidate_id)) ||
        new Set(page.leads.map((row) => row.id)).size !== page.leads.length
      )
        throw unavailable();
      await sourceFence(server, "list_crm_campaigns");
      return finish({
        operation: "sequenceStats",
        items: recruiting.sequenceStatsFromLeads(
          page.leads.map((row) => ({
            crmLeadId: row.id,
            crmCampaignId: row.campaign_id,
            crmCandidateId: row.candidate_id,
            status: row.status,
            openCount: row.email_open_count,
            replyCount: row.email_reply_count,
            lastContactAt: row.timestamp_last_contact ? new Date(row.timestamp_last_contact) : null,
            lastReplyAt: row.timestamp_last_reply ? new Date(row.timestamp_last_reply) : null,
            syncedAt: new Date(row.synced_at),
          })),
        ),
      });
    }
    if (input.operation === "unassignedSequences") {
      const page = parse(
        RecruitingCrmUnassignedReadSchema,
        await read(server, "list_crm_campaigns", {
          p_org: input.organizationId,
          p_view: "unassigned",
        }),
      );
      if (
        page.organization_id !== input.organizationId ||
        new Set(page.campaigns.map((row) => row.id)).size !== page.campaigns.length
      )
        throw unavailable();
      await sourceFence(server, "list_crm_campaigns");
      const updated = (row: (typeof page.campaigns)[number]) =>
        Date.parse(row.timestamp_updated ?? "") || 0;
      return finish({
        operation: "unassignedSequences",
        items: [...page.campaigns]
          .sort((a, b) => updated(b) - updated(a) || (a.id < b.id ? -1 : 1))
          .map((row) => ({
            id: row.id,
            name: row.name,
            status: recruiting.sequenceStatus(row.status),
            people: row.people,
            opened: row.opened,
            replied: row.replied,
            lastContactAt: row.last_contact_at,
            syncedAt: row.synced_at,
          })),
      });
    }
    if (input.operation === "campaigns" || input.operation === "campaignLeads") {
      const offset = pageOffset(input);
      const limit = input.limit ?? 25;
      const leads = input.operation === "campaignLeads";
      const done = (items: unknown[], nextOffset: number | null) =>
        finish({
          operation: input.operation,
          ...(leads ? { campaignId: input.campaignId } : {}),
          items,
          offset,
          nextOffset,
        });
      const value = await read(server, "list_crm_campaigns", {
        p_org: input.organizationId,
        ...(leads ? { p_view: "leads", p_campaign: input.campaignId } : { p_view: "campaigns" }),
        p_limit: limit,
        p_offset: offset,
      });
      const badPage = (next: number | null, rows: number) =>
        rows > limit || (next !== null && next <= offset);
      if (leads) {
        const page = parse(RecruitingCrmCampaignLeadsReadSchema, value);
        if (
          page.organization_id !== input.organizationId ||
          page.campaign_id !== input.campaignId ||
          badPage(page.next_offset, page.leads.length) ||
          new Set(page.leads.map((row) => row.id)).size !== page.leads.length
        )
          throw unavailable();
        await sourceFence(server, "list_crm_campaigns");
        return done(
          page.leads.map((row) => ({
            id: row.id,
            candidateId: row.candidate_id,
            status: row.status,
            interestStatus: row.interest_status,
            openCount: row.email_open_count,
            replyCount: row.email_reply_count,
            lastContactAt: row.timestamp_last_contact,
            lastReplyAt: row.timestamp_last_reply,
            syncedAt: row.synced_at,
          })),
          page.next_offset,
        );
      }
      const page = parse(RecruitingCrmCampaignsReadSchema, value);
      if (
        page.organization_id !== input.organizationId ||
        badPage(page.next_offset, page.campaigns.length) ||
        new Set(page.campaigns.map((row) => row.id)).size !== page.campaigns.length
      )
        throw unavailable();
      await sourceFence(server, "list_crm_campaigns");
      return done(
        page.campaigns.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          crmRoleId: row.role_spec_id,
          clientId: row.client_id,
          createdAt: row.timestamp_created,
          updatedAt: row.timestamp_updated,
          syncedAt: row.synced_at,
        })),
        page.next_offset,
      );
    }
    if (input.operation === "presence") {
      const page = parse(
        RecruitingCrmPresenceReadSchema,
        await read(server, "list_crm_candidates", {
          p_view: "presence",
          p_org: input.organizationId,
          p_candidate_ids: input.candidateIds,
          ...(input.crmRoleId ? { p_role: input.crmRoleId } : {}),
        }),
      );
      if (
        page.candidate_ids.some((id) => !input.candidateIds.includes(id)) ||
        page.role_candidate_ids?.some((id) => !page.candidate_ids.includes(id)) ||
        (input.crmRoleId && !page.role_candidate_ids)
      )
        throw unavailable();
      await sourceFence(server, "list_crm_candidates");
      return {
        operation: "presence",
        source,
        checkedAt: new Date().toISOString(),
        candidateIds: page.candidate_ids,
        ...(page.role_candidate_ids ? { roleCandidateIds: page.role_candidate_ids } : {}),
      };
    }
    if (input.operation === "candidates") {
      const trim = (text: string) => text.replace(/^ +| +$/g, "");
      let selectedRole = null;
      if (input.crmRoleId) {
        const [choices, row] = await Promise.all([
          roles(),
          read(server, "get_crm_role", {
            p_org: input.organizationId,
            p_role: input.crmRoleId,
          }).then((value) => parse(RecruitingCrmRoleReadSchema, value)),
        ]);
        const sameLabels = choices.filter(
          (role) =>
            trim(role.clientLabel) === trim(row.client_label) &&
            trim(role.roleLabel) === trim(row.role_label),
        );
        if (
          !trim(row.client_label) ||
          !trim(row.role_label) ||
          row.role_spec_id !== input.crmRoleId ||
          sameLabels.length !== 1 ||
          sameLabels[0]!.crmRoleId !== input.crmRoleId ||
          sameLabels[0]!.clientId !== row.client_id
        )
          throw new ORPCError("CONFLICT", {
            message: "This CRM role could not be matched unambiguously. Refresh the roles.",
          });
        selectedRole = {
          crmRoleId: row.role_spec_id,
          clientId: row.client_id,
          clientLabel: row.client_label,
          roleLabel: row.role_label,
          summary: row.summary,
          description: row.description,
          jdText: row.jd_text,
          jdUrl: row.jd_url,
        };
      }
      const offset = pageOffset(input);
      const limit = input.limit ?? 25;
      if (options?.source === "projection") {
        if (!selectedRole) throw new IsolationError();
        // Stored data has exactly the live candidate tool's authorization boundary.
        await sourceFence(server, "list_crm_candidates");
        const stored = await recruiting.listSyncedRecruitingCrmRoleContacts(
          deps.prisma,
          actor,
          { mcpServerId: server.id, organizationId: input.organizationId },
          selectedRole.crmRoleId,
        );
        if (stored === null) throw unavailable();
        invalidateFences();
        await sourceFence(server, "list_crm_candidates");
        const query = input.query?.trim().toLocaleLowerCase();
        const matching = stored.filter(
          (row) =>
            (!input.stage || row.stage === input.stage) &&
            (!query ||
              [row.name, row.email, row.title].some((value) =>
                value?.toLocaleLowerCase().includes(query),
              )),
        );
        const items = matching.slice(offset, offset + limit);
        return finish({
          operation: "candidates",
          scope: "stored_role",
          selectedRole,
          items,
          total: matching.length,
          offset,
          nextOffset: offset + items.length < matching.length ? offset + items.length : null,
        });
      }
      const page = parse(
        RecruitingCrmCandidatesReadSchema,
        await read(server, "list_crm_candidates", {
          p_org: input.organizationId,
          p_not_reviewed: false,
          p_limit: limit,
          p_offset: offset,
          ...(input.query ? { p_q: input.query } : {}),
          ...(input.stage ? { p_stage: input.stage } : {}),
          ...(input.includeArchived ? { p_include_archived: true } : {}),
          ...(selectedRole
            ? { p_client: selectedRole.clientLabel, p_role: selectedRole.roleLabel }
            : {}),
        }),
      );
      if (
        page.rows.length > limit ||
        (input.stage && page.rows.some((row) => row.stage !== input.stage)) ||
        (selectedRole &&
          page.rows.some(
            (row) =>
              trim(row.client_label) !== trim(selectedRole.clientLabel) ||
              trim(row.role_label) !== trim(selectedRole.roleLabel),
          )) ||
        new Set(page.rows.map((row) => row.candidate_id)).size !== page.rows.length
      )
        throw unavailable();
      return finish({
        operation: input.operation,
        scope: selectedRole ? "legacy_role_labels" : "organization",
        selectedRole,
        items: page.rows.map(candidate),
        total: page.total,
        offset,
        nextOffset:
          page.rows.length && offset + page.rows.length < page.total
            ? offset + page.rows.length
            : null,
      });
    }
    if (input.crmRoleId) {
      if (
        input.cursor &&
        (!("p_role" in input.cursor) ||
          input.cursor.p_org !== input.organizationId ||
          input.cursor.p_role !== input.crmRoleId ||
          input.cursor.p_candidate !== input.candidateId)
      )
        throw new IsolationError();
      const offset = input.cursor && "offset" in input.cursor ? input.cursor.offset : 0;
      const limit = input.limit ?? 25;
      const page = parse(
        RecruitingCrmRoleMailReadSchema,
        await read(server, "list_crm_role_correspondence", {
          p_org: input.organizationId,
          p_role: input.crmRoleId,
          p_candidate: input.candidateId,
          p_limit: limit,
          p_offset: offset,
        }),
      );
      if (
        page.organization_id !== input.organizationId ||
        page.role_id !== input.crmRoleId ||
        page.candidate_id !== input.candidateId ||
        page.messages.length > limit ||
        page.messages.some(
          (row) =>
            row.organization_id !== input.organizationId || row.candidate_id !== input.candidateId,
        ) ||
        new Set(page.messages.map((row) => row.id)).size !== page.messages.length ||
        (page.next_offset !== null &&
          (!page.messages.length || page.next_offset !== offset + page.messages.length))
      )
        throw unavailable();
      const native = await nativeRecruitingCorrespondence(deps.prisma, actor, target.threadId, {
        target: {
          mcpServerId: server.id,
          serverRevision: server.revision,
          organizationId: input.organizationId,
          crmRoleId: input.crmRoleId,
        },
        candidateId: input.candidateId,
        crmEndpoint: deps.firstPartyMcpUrl,
      });
      invalidateFences();
      await sourceFence(server, "list_crm_role_correspondence");
      await native.assertCurrent?.();
      return finish({
        operation: input.operation,
        scope: "stored_candidate_correspondence",
        outboxScope: "unavailable_for_role",
        outbox: [],
        candidateId: input.candidateId,
        nativeCorrespondence: native.items,
        items: page.messages.map((row) => ({
          ...mailItem(row),
          ...(row.eaccount !== undefined ? { eaccount: row.eaccount } : {}),
        })),
        nextCursor:
          page.next_offset === null
            ? null
            : {
                p_org: input.organizationId,
                p_role: input.crmRoleId,
                p_candidate: input.candidateId,
                offset: page.next_offset,
              },
      });
    }
    if (input.cursor && "p_role" in input.cursor) throw new IsolationError();
    if (
      input.cursor &&
      (input.cursor.p_org !== input.organizationId ||
        input.cursor.p_candidate !== input.candidateId)
    )
      throw new IsolationError();
    const [messages, page] = await Promise.all([
      outbox(input.candidateId),
      read(server, "list_crm_candidate_correspondence", {
        p_org: input.organizationId,
        p_candidate: input.candidateId,
        p_limit: input.limit ?? 25,
        ...(input.cursor ? { p_cursor: input.cursor } : {}),
      }).then((value) => parse(RecruitingCrmMailReadSchema, value)),
    ]);
    if (
      page.messages.length > (input.limit ?? 25) ||
      page.organization_id !== input.organizationId ||
      page.candidate_id !== input.candidateId ||
      page.messages.some(
        (row) =>
          row.organization_id !== input.organizationId ||
          (row.candidate_id !== null && row.candidate_id !== input.candidateId) ||
          (row.candidate_id === null && !row.lead_email),
      ) ||
      new Set(page.messages.map((row) => row.id)).size !== page.messages.length ||
      (page.next_cursor &&
        (page.next_cursor.p_org !== input.organizationId ||
          page.next_cursor.p_candidate !== input.candidateId ||
          page.next_cursor.linked_offset < (input.cursor?.linked_offset ?? 0) ||
          page.next_cursor.unlinked_offset < (input.cursor?.unlinked_offset ?? 0) ||
          page.next_cursor.linked_offset + page.next_cursor.unlinked_offset <=
            (input.cursor?.linked_offset ?? 0) + (input.cursor?.unlinked_offset ?? 0)))
    )
      throw unavailable();
    await sourceFence(server, "list_crm_candidate_messages");
    return finish({
      operation: input.operation,
      scope: "stored_candidate_correspondence",
      outbox: messages,
      candidateId: input.candidateId,
      nativeCorrespondence: [],
      items: page.messages.map(mailItem),
      nextCursor: page.next_cursor,
    });
  });
}

type RoleCandidatesInput = {
  threadId: string;
  limit?: number | undefined;
  cursor?: string | undefined;
  sort?: "score" | "rank" | "name" | "recent" | undefined;
  query?: string | undefined;
  shortlistedOnly?: boolean | undefined;
};
type RoleCandidatesAutumnPage = Pick<
  ListRecruitingCandidatesOutput,
  "items" | "nextCursor" | "total" | "counts" | "crmTarget"
>;
type RoleCandidatesCrmRow = Extract<
  RecruitingCrmDataOutput,
  { operation: "candidates" }
>["items"][number] & { serverId: string; organizationId: string };
export type RoleCandidatesSources = {
  autumn(cursor: string | undefined, limit: number): Promise<RoleCandidatesAutumnPage>;
  autumnLinkedinUrls(): Promise<string[]>;
  crm(
    target: RecruitingCrmTarget,
  ): Promise<{ status: "ok"; rows: RoleCandidatesCrmRow[] } | { status: "unavailable" }>;
};

/** `linkedin.com/in/<slug>` regardless of scheme, subdomain, case, query or trailing slash. */
export function linkedinIdentity(url: string | null | undefined): string | null {
  const text = url?.trim().toLowerCase();
  if (!text) return null;
  const profile = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^/?#\s]+)/.exec(text);
  return profile ? `linkedin.com/in/${profile[1]}` : text.replace(/[/?#]+$/, "");
}

const roleCandidatesCursor = {
  read(raw: string | undefined, scope: string): { a?: string; o?: number } {
    if (raw === undefined) return {};
    try {
      const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (
        value?.s === scope &&
        (value.a === undefined || (typeof value.a === "string" && value.a)) &&
        (value.o === undefined || (Number.isSafeInteger(value.o) && value.o >= 0)) &&
        (value.a === undefined) !== (value.o === undefined)
      )
        return value.a === undefined ? { o: value.o } : { a: value.a };
    } catch {}
    throw new RecruitingConflictError();
  },
  write: (scope: string, position: { a: string } | { o: number }) =>
    Buffer.from(JSON.stringify({ s: scope, ...position })).toString("base64url"),
};

/**
 * Merges one page of Autumn results with the role's CRM contacts. Pages Autumn first (its own
 * cursor/sort), then the CRM-only contacts by offset; the cursor carries whichever position is live.
 */
export async function mergeRoleCandidates(
  input: RoleCandidatesInput,
  sources: RoleCandidatesSources,
): Promise<RecruitingRoleCandidatesOutput> {
  const limit = input.limit ?? 25;
  const scope = JSON.stringify([
    input.threadId,
    input.sort ?? "score",
    input.query ?? "",
    input.shortlistedOnly === true,
  ]);
  const position = roleCandidatesCursor.read(input.cursor, scope);
  const autumnPhase = position.o === undefined;
  // ponytail: the CRM phase still reads one Autumn row for totals, counts and the CRM binding.
  const autumn = await sources.autumn(position.a, autumnPhase ? limit : 1);
  const crm = autumn.crmTarget
    ? await sources.crm(autumn.crmTarget.target)
    : ({ status: "not_bound" } as const);
  // One slot per person: LinkedIn identity first, then lowercased email. Autumn rows have no email.
  type Slot = { autumn: boolean; crm: RoleCandidatesCrmRow | null };
  const owners = new Map<string, Slot>();
  const crmOnly: RoleCandidatesCrmRow[] = [];
  const outreach: Record<string, number> = {};
  if (crm.status === "ok" && crm.rows.length) {
    for (const url of await sources.autumnLinkedinUrls()) {
      const key = linkedinIdentity(url);
      if (key && !owners.has(`li:${key}`)) owners.set(`li:${key}`, { autumn: true, crm: null });
    }
    for (const row of crm.rows) {
      const li = linkedinIdentity(row.linkedinUrl);
      const email = row.email?.trim().toLowerCase() || null;
      const keys = [li && `li:${li}`, email && `em:${email}`].filter((key) => key !== null);
      let slot = keys.map((key) => owners.get(key)).find((found) => found !== undefined);
      if (!slot) {
        slot = { autumn: false, crm: row };
        crmOnly.push(row);
      } else if (!slot.crm) slot.crm = row;
      else continue; // Same person listed twice in the CRM.
      outreach[row.outreachStatus] = (outreach[row.outreachStatus] ?? 0) + 1;
      for (const key of keys) if (!owners.has(key)) owners.set(key, slot);
    }
  }
  const needle = input.query?.trim().replace(/\s+/g, " ").toLowerCase();
  const visibleCrmOnly = input.shortlistedOnly
    ? []
    : crmOnly.filter(
        (row) =>
          !needle ||
          [row.name, row.email, row.title].some((text) =>
            text?.replace(/\s+/g, " ").toLowerCase().includes(needle),
          ),
      );
  if (input.sort === "name")
    visibleCrmOnly.sort(
      (left, right) =>
        left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
        left.candidateId.localeCompare(right.candidateId),
    );
  const crmSide = (row: RoleCandidatesCrmRow | null | undefined) =>
    row
      ? {
          serverId: row.serverId,
          organizationId: row.organizationId,
          candidateId: row.candidateId,
          stage: row.stage,
          contactStatus: row.contactStatus,
          outreachStatus: row.outreachStatus,
          phone: row.phone,
          ...(row.company !== undefined ? { company: row.company } : {}),
          ...(row.profile !== undefined ? { profile: row.profile } : {}),
          ...(row.interest !== undefined ? { interest: row.interest } : {}),
          ...(row.reviewed !== undefined ? { reviewed: row.reviewed } : {}),
          ...(row.lastReplyAt !== undefined ? { lastReplyAt: row.lastReplyAt } : {}),
          ...(row.resumeReceived !== undefined ? { resumeReceived: row.resumeReceived } : {}),
        }
      : null;
  const items: RecruitingRoleCandidate[] = [];
  let nextCursor: string | null = null;
  if (autumnPhase)
    for (const candidate of autumn.items) {
      const li = linkedinIdentity(candidate.linkedinUrl);
      const slot = li ? owners.get(`li:${li}`) : undefined;
      const contact = (slot?.autumn && slot.crm) || null;
      const fields = candidate.latestSource?.report?.fields ?? [];
      items.push({
        key: `autumn:${candidate.candidateKey}`,
        name: candidate.name ?? contact?.name ?? null,
        title: candidate.title ?? contact?.title ?? null,
        location: candidate.location ?? contact?.location ?? null,
        email: contact?.email ?? null,
        linkedinUrl: candidate.linkedinUrl ?? contact?.linkedinUrl ?? null,
        autumn: {
          candidateKey: candidate.candidateKey,
          score: candidate.match?.score ?? null,
          rank: candidate.match?.rank ?? null,
          tier: candidate.match?.tier ?? null,
          matchSummary: fields.find((field) => /summary/i.test(field.label))?.value ?? null,
          criteria: fields.flatMap((field) =>
            field.providerStatus
              ? [
                  {
                    label: field.label,
                    status: field.providerStatus,
                    evidence: field.evidence ?? null,
                  },
                ]
              : [],
          ),
        },
        crm: crmSide(contact),
        shortlisted: candidate.shortlisted,
        shortlistedAt: candidate.shortlistedAt,
      });
    }
  if (autumnPhase && autumn.nextCursor)
    nextCursor = roleCandidatesCursor.write(scope, { a: autumn.nextCursor });
  else {
    const offset = position.o ?? 0;
    const page = visibleCrmOnly.slice(offset, offset + limit - items.length);
    for (const row of page)
      items.push({
        key: `crm:${row.candidateId}`,
        name: row.name,
        title: row.title,
        location: row.location,
        email: row.email,
        linkedinUrl: row.linkedinUrl,
        autumn: null,
        crm: crmSide(row),
        shortlisted: false,
        shortlistedAt: null,
      });
    if (offset + page.length < visibleCrmOnly.length)
      nextCursor = roleCandidatesCursor.write(scope, { o: offset + page.length });
  }
  return {
    items,
    nextCursor,
    total: autumn.total + visibleCrmOnly.length,
    counts: { ...outreach, shortlisted: autumn.counts.shortlisted, replied: outreach.replied ?? 0 },
    crmStatus: crm.status,
    // Stored role/contact rows do not prove a completed CRM pass. Keep observed counts,
    // but never label them exact solely because source authorization succeeded.
    crmCountsComplete: false,
  };
}

/** `recruiting.roleCandidates`: existing Autumn list + existing CRM candidates read, merged. */
export async function getRecruitingRoleCandidates(
  deps: RecruitingReadDeps & Omit<RecruitingCrmReadDeps, "prisma">,
  actor: Actor,
  target: ThreadTarget,
  input: RoleCandidatesInput,
): Promise<RecruitingRoleCandidatesOutput> {
  if (target.threadId !== input.threadId) throw new IsolationError();
  const roleId = await authenticated(() =>
    recruiting.getRecruitingWorkspaceRoleId(deps.prisma, actor, { threadId: input.threadId }),
  );
  if (!roleId)
    return {
      items: [],
      nextCursor: null,
      total: 0,
      counts: { shortlisted: 0, replied: 0 },
      crmStatus: "not_bound",
      crmCountsComplete: false,
    };
  const sort = input.sort ?? "score";
  return mergeRoleCandidates(input, {
    autumn: (cursor, limit) =>
      listRecruitingCandidates(deps, actor, {
        roleId,
        limit,
        sort,
        ...(cursor ? { cursor } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.shortlistedOnly ? { shortlisted: true } : {}),
      }),
    autumnLinkedinUrls: () =>
      authenticated(() =>
        recruiting.listRecruitingCandidateLinkedinUrls(deps.prisma, actor, roleId),
      ),
    async crm(binding) {
      const rows: RoleCandidatesCrmRow[] = [];
      try {
        // Read the role's people live from the CRM, so replies and status are current.
        for (let offset: number | null = 0; offset !== null; ) {
          const page: RecruitingCrmDataOutput = await getRecruitingCrmData(deps, actor, target, {
            operation: "candidates",
            serverId: binding.mcpServerId,
            serverRevision: binding.serverRevision,
            organizationId: binding.organizationId,
            crmRoleId: binding.crmRoleId,
            limit: 50,
            offset,
          });
          if (page.operation !== "candidates") throw new IsolationError();
          for (const item of page.items)
            rows.push({
              ...item,
              serverId: page.source.serverId,
              organizationId: page.source.organizationId,
            });
          offset = page.nextOffset;
        }
      } catch (error) {
        // Never substitute stored data when current source authorization cannot be verified.
        if (!(error instanceof ORPCError) && !(error instanceof IsolationError)) throw error;
        return { status: "unavailable" };
      }
      return { status: "ok", rows };
    },
  });
}

export const listRecruitingReminders = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingReminders>[2],
) => authenticated(() => recruiting.listRecruitingReminders(prisma, actor, input));
export const createRecruitingReminder = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingReminder>[2],
) => authenticated(() => recruiting.createRecruitingReminder(prisma, actor, input));
export const updateRecruitingReminder = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.updateRecruitingReminder>[2],
) => authenticated(() => recruiting.updateRecruitingReminder(prisma, actor, input));
export const deleteRecruitingReminder = (
  prisma: PrismaClient,
  actor: Actor,
  input: { id: string },
) => authenticated(() => recruiting.deleteRecruitingReminder(prisma, actor, input.id));

export const listRecruitingCandidateNotes = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidateNotes>[2],
) => authenticated(() => recruiting.listRecruitingCandidateNotes(prisma, actor, input));
export const createRecruitingCandidateNote = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingCandidateNote>[2],
) => authenticated(() => recruiting.createRecruitingCandidateNote(prisma, actor, input));
export const updateRecruitingCandidateNote = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.updateRecruitingCandidateNote>[2],
) => authenticated(() => recruiting.updateRecruitingCandidateNote(prisma, actor, input));
export const deleteRecruitingCandidateNote = (
  prisma: PrismaClient,
  actor: Actor,
  input: { id: string },
) => authenticated(() => recruiting.deleteRecruitingCandidateNote(prisma, actor, input.id));
export const readRecruitingCalibrationRound = (
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
) => authenticated(() => recruiting.readRecruitingCalibrationRound(prisma, actor, input));

/** The panel's "start finding more" control: the signed-in recruiter accepts the latest round. */
export const approveRecruitingCalibrationRound = (
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; round: number },
) =>
  authenticated(async () => {
    try {
      return await recruiting.approveRecruitingCalibrationRound(prisma, actor, input);
    } catch (error) {
      if (error instanceof recruiting.RecruitingCalibrationRoundError)
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      throw error;
    }
  });

export const listRecruitingProfileActivity = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingProfileActivity>[2],
) => authenticated(() => recruiting.listRecruitingProfileActivity(prisma, actor, input));

export const recordRecruitingProfileView = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.recordRecruitingProfileView>[2],
) => authenticated(() => recruiting.recordRecruitingProfileView(prisma, actor, input));
