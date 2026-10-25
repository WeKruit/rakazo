import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  Actor,
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmSyncCursor,
  RecruitingCrmSyncOutput,
} from "@rakazo/contracts";
import { RecruitingCrmSyncCursorSchema } from "@rakazo/contracts";
import type { CrmSyncContact, CrmSyncScope, PrismaClient } from "@rakazo/db";
import * as recruiting from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RecruitingCrmReadDeps } from "./recruiting.js";
import { getRecruitingCrmData, linkedinIdentity } from "./recruiting.js";
import type { ThreadTarget } from "./thread-target.js";

const PAGE = 50;
const MAX_SKIPPED = 50;
/** Each call stops starting new reads after this long and hands back a cursor. */
const DEFAULT_BUDGET_MS = 40_000;
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type CrmRead = (input: RecruitingCrmDataInput) => Promise<RecruitingCrmDataOutput>;
type Skipped = RecruitingCrmSyncOutput["skipped"][number];

type Cursor = RecruitingCrmSyncCursor;

function decode(raw: unknown, dryRun: boolean, now: Date): Cursor {
  let cursor: Cursor;
  try {
    cursor = RecruitingCrmSyncCursorSchema.parse(raw);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Start the CRM sync again." });
  }
  const age = now.getTime() - new Date(cursor.startedAt).getTime();
  if (cursor.dryRun !== dryRun || age < 0 || age > CURSOR_MAX_AGE_MS)
    throw new ORPCError("BAD_REQUEST", { message: "Start the CRM sync again." });
  return cursor;
}

/** A CRM read that failed or was refused; anything else (authorization) propagates. */
const readFailure = (error: unknown) =>
  error instanceof ORPCError &&
  ["SERVICE_UNAVAILABLE", "CONFLICT", "NOT_FOUND", "BAD_GATEWAY"].includes(error.code)
    ? error.message
    : null;

export function crmSyncContact(
  item: Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"][number],
): CrmSyncContact {
  const linkedin = linkedinIdentity(item.linkedinUrl);
  const email = item.email?.trim().toLowerCase() || null;
  return {
    crmCandidateId: item.candidateId,
    name: item.name,
    title: item.title,
    ...(item.company !== undefined ? { company: item.company } : {}),
    ...(item.profile !== undefined ? { profile: item.profile } : {}),
    location: item.location,
    email: item.email,
    phone: item.phone,
    linkedinUrl: item.linkedinUrl,
    identityKey: linkedin ? `li:${linkedin}` : email ? `em:${email}` : null,
    stage: item.stage,
    contactStatus: item.contactStatus,
    outreachStatus: item.outreachStatus,
    interest: item.interest ?? null,
    reviewed: item.reviewed ?? null,
    lastReplyAt: item.lastReplyAt ? new Date(item.lastReplyAt) : null,
    resumeReceived: item.resumeReceived ?? null,
    crmRoleId: item.roleSpecId,
    clientLabel: item.legacyClientLabel,
    roleLabel: item.legacyRoleLabel,
  };
}

/**
 * Copies the acting user's CRM roles, contacts, role links and role mail into the product's
 * owner-scoped rows through the same authorized CRM reads the product already uses. Re-runnable:
 * rows are keyed by CRM ids, CRM rows are only read, and nothing local is deleted (a row missing
 * from a complete pass is archived). Each call does a bounded slice and returns `nextCursor`.
 */
export async function syncRecruitingCrm(
  deps: RecruitingCrmReadDeps,
  actor: Actor,
  target: ThreadTarget,
  input: { dryRun?: boolean | undefined; cursor?: string | undefined },
  options: { budgetMs?: number; now?: () => Date; read?: CrmRead } = {},
): Promise<RecruitingCrmSyncOutput> {
  const began = performance.now();
  // Match the transaction wait + execution bounds; no provider payload enters telemetry.
  const duration = () => Math.max(0, Math.min(125_000, Math.round(performance.now() - began)));
  // Serialize progress and projection writes for this owner; opaque single-use tokens never
  // let a caller choose an offset, scope or archive timestamp.
  let report: RecruitingCrmSyncOutput;
  try {
    report = await deps.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actor.userId, actor.spaceId, "crm-sync"])}, 0))`;
        return syncSlice({ ...deps, prisma: tx as PrismaClient }, actor, target, input, options);
      },
      { timeout: 120_000, maxWait: 5_000 },
    );
  } catch (error) {
    getLogger().error("crm.sync.failed", {
      dry_run: input.dryRun === true,
      duration_ms: duration(),
    });
    throw error;
  }
  // Emit only after commit. Counts are cumulative across slices, not per-slice deltas.
  const summary = {
    dry_run: report.dryRun,
    duration_ms: duration(),
    has_more: report.nextCursor !== null,
    organizations: report.organizations,
    roles_seen: report.roles.seen,
    contacts_seen: report.contacts.seen,
    links_seen: report.links.seen,
    messages_seen: report.messages.seen,
    skipped_count: report.skipped.length,
  };
  if (report.skipped.length) getLogger().warn("crm.sync.incomplete", summary);
  else
    getLogger().info(report.nextCursor === null ? "crm.sync.completed" : "crm.sync.slice", summary);
  return report;
}

async function syncSlice(
  deps: RecruitingCrmReadDeps,
  actor: Actor,
  target: ThreadTarget,
  input: { dryRun?: boolean | undefined; cursor?: string | undefined },
  options: { budgetMs?: number; now?: () => Date; read?: CrmRead },
): Promise<RecruitingCrmSyncOutput> {
  const clock = options.now ?? (() => new Date());
  const began = clock();
  const dryRun = input.dryRun === true;
  const read: CrmRead =
    options.read ??
    ((request) =>
      getRecruitingCrmData(deps, actor, target, request) as Promise<RecruitingCrmDataOutput>);
  const prisma: PrismaClient = deps.prisma;
  const skip = (cursor: Cursor, entry: Skipped) => {
    if (cursor.skipped.length < MAX_SKIPPED) cursor.skipped.push(entry);
  };
  const owner = { userId: actor.userId, spaceId: actor.spaceId };
  const targetKey = JSON.stringify([target.kind, target.threadId]);
  const saved = input.cursor
    ? await prisma.recruitingCrmSyncProgress.findUnique({
        where: { userId_spaceId: owner },
      })
    : null;
  if (input.cursor && (!saved || saved.token !== input.cursor || saved.targetKey !== targetKey))
    throw new ORPCError("BAD_REQUEST", { message: "Start the CRM sync again." });
  const cursor: Cursor = saved
    ? decode(saved.progress, dryRun, began)
    : await start(prisma, actor, read, dryRun, began, skip);
  const since = new Date(cursor.startedAt);
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const write = { dryRun, now: began };
  /**
   * Next unit: contacts, then links and mail for each role, then the organization's stored
   * campaigns and each campaign's leads, then the next organization.
   */
  const advance = () => {
    const org = cursor.orgs[cursor.at.g]!;
    const roles = org.roles.length;
    const campaigns = org.campaigns?.length ?? 0;
    const { g, step, j } = cursor.at;
    const next: Pick<Cursor["at"], "g" | "step" | "j"> =
      step === "contacts" && roles
        ? { g, step: "links", j: 0 }
        : step === "links"
          ? { g, step: "mail", j }
          : step === "mail" && j + 1 < roles
            ? { g, step: "links", j: j + 1 }
            : step === "contacts" || step === "mail"
              ? { g, step: "campaigns", j: 0 }
              : step === "campaigns" && campaigns
                ? { g, step: "leads", j: 0 }
                : step === "leads" && j + 1 < campaigns
                  ? { g, step: "leads", j: j + 1 }
                  : { g: g + 1, step: "contacts", j: 0 };
    cursor.at = { ...next, offset: 0, matched: 0, seen: [] };
  };
  // At least one read per call, so a cursor always makes progress.
  for (let first = true; cursor.at.g < cursor.orgs.length; first = false) {
    if (!first && clock().getTime() - began.getTime() >= budget) break;
    const org = cursor.orgs[cursor.at.g]!;
    const scope: CrmSyncScope = { mcpServerId: org.s, organizationId: org.o };
    const pinned = { serverId: org.s, serverRevision: org.r, organizationId: org.o };
    const { step, j, offset } = cursor.at;
    const crmRoleId = step === "links" || step === "mail" ? org.roles[j]! : null;
    try {
      if (step === "campaigns") {
        const page = await read({ operation: "campaigns", ...pinned, limit: PAGE, offset });
        if (page.operation !== "campaigns") throw new ORPCError("SERVICE_UNAVAILABLE");
        if (offset === 0) org.campaigns = [];
        org.campaigns = [...new Set([...(org.campaigns ?? []), ...page.items.map((c) => c.id)])];
        recruiting.addCrmSyncCounts(
          cursor.totals.campaigns,
          await recruiting.syncRecruitingCrmCampaigns(
            prisma,
            actor,
            scope,
            page.items.map((item) => ({
              crmCampaignId: item.id,
              name: item.name,
              status: item.status,
              crmRoleId: item.crmRoleId,
              clientId: item.clientId,
              campaignCreatedAt: item.createdAt ? new Date(item.createdAt) : null,
              campaignUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
              mirrorSyncedAt: new Date(item.syncedAt),
            })),
            write,
          ),
        );
        if (page.nextOffset !== null && page.items.length) cursor.at.offset = page.nextOffset;
        else advance();
        continue;
      }
      if (step === "leads") {
        const campaignId = org.campaigns![j]!;
        const page = await read({
          operation: "campaignLeads",
          ...pinned,
          campaignId,
          limit: PAGE,
          offset,
        });
        if (page.operation !== "campaignLeads") throw new ORPCError("SERVICE_UNAVAILABLE");
        recruiting.addCrmSyncCounts(
          cursor.totals.leads,
          await recruiting.syncRecruitingCrmLeads(
            prisma,
            actor,
            scope,
            page.items.map((item) => ({
              crmLeadId: item.id,
              crmCampaignId: campaignId,
              crmCandidateId: item.candidateId,
              status: item.status,
              interestStatus: item.interestStatus,
              openCount: item.openCount,
              replyCount: item.replyCount,
              lastContactAt: item.lastContactAt ? new Date(item.lastContactAt) : null,
              lastReplyAt: item.lastReplyAt ? new Date(item.lastReplyAt) : null,
              mirrorSyncedAt: new Date(item.syncedAt),
            })),
            write,
          ),
        );
        if (page.nextOffset !== null && page.items.length) cursor.at.offset = page.nextOffset;
        else advance();
        continue;
      }
      if (step === "contacts" || step === "links") {
        const page = await read({
          operation: "candidates",
          ...pinned,
          ...(crmRoleId ? { crmRoleId } : {}),
          limit: PAGE,
          offset,
        });
        if (page.operation !== "candidates") throw new ORPCError("SERVICE_UNAVAILABLE");
        const contacts = page.items.map(crmSyncContact);
        cursor.at.seen.push(...contacts.map((contact) => contact.crmCandidateId));
        if (step === "contacts") {
          const counts = await recruiting.syncRecruitingCrmContacts(
            prisma,
            actor,
            scope,
            contacts,
            write,
          );
          cursor.at.matched += counts.unchanged + counts.updated;
          recruiting.addCrmSyncCounts(cursor.totals.contacts, counts);
        } else {
          // A contact may arrive after the organization pass. Persist it before its link.
          await recruiting.syncRecruitingCrmContacts(prisma, actor, scope, contacts, write);
          const counts = await recruiting.syncRecruitingCrmRoleLinks(
            prisma,
            actor,
            scope,
            crmRoleId!,
            contacts.map((contact) => contact.crmCandidateId),
            write,
          );
          cursor.at.matched += counts.unchanged;
          recruiting.addCrmSyncCounts(cursor.totals.links, counts);
        }
        if (page.nextOffset !== null && page.items.length) {
          cursor.at.offset = page.nextOffset;
          continue;
        }
        // Offset pages are not snapshots. A moved row may be skipped; re-check exact
        // identities before archiving, through the same authorized source boundary.
        const owned = { userId: actor.userId, spaceId: actor.spaceId, ...scope };
        const unseen =
          step === "contacts"
            ? await prisma.recruitingCrmContact.findMany({
                where: {
                  ...owned,
                  archivedAt: null,
                  syncedAt: { lt: since },
                  crmCandidateId: { notIn: cursor.at.seen },
                },
                select: { crmCandidateId: true },
              })
            : (
                await prisma.recruitingCrmRoleContact.findMany({
                  where: {
                    archivedAt: null,
                    syncedAt: { lt: since },
                    role: { ...owned, crmRoleId: crmRoleId! },
                    contact: { crmCandidateId: { notIn: cursor.at.seen } },
                  },
                  select: { contact: { select: { crmCandidateId: true } } },
                })
              ).map((link) => link.contact);
        const absent: string[] = [];
        for (let offset = 0; offset < unseen.length; offset += PAGE) {
          const ids = unseen.slice(offset, offset + PAGE).map((row) => row.crmCandidateId);
          const presence = await read({
            operation: "presence",
            ...pinned,
            candidateIds: ids,
            ...(crmRoleId ? { crmRoleId } : {}),
          });
          if (presence.operation !== "presence") throw new ORPCError("SERVICE_UNAVAILABLE");
          const present = step === "contacts" ? presence.candidateIds : presence.roleCandidateIds;
          if (!present) throw new ORPCError("SERVICE_UNAVAILABLE");
          absent.push(...ids.filter((id) => !present.includes(id)));
        }
        // Do not archive any row until every absence read for this unit succeeds.
        const archived = dryRun
          ? absent.length
          : step === "contacts"
            ? (
                await prisma.recruitingCrmContact.updateMany({
                  where: {
                    ...owned,
                    archivedAt: null,
                    crmCandidateId: { in: absent },
                    syncedAt: { lt: since },
                  },
                  data: { archivedAt: began, syncedAt: began },
                })
              ).count
            : (
                await prisma.recruitingCrmRoleContact.updateMany({
                  where: {
                    archivedAt: null,
                    role: { ...owned, crmRoleId: crmRoleId! },
                    contact: { crmCandidateId: { in: absent } },
                    syncedAt: { lt: since },
                  },
                  data: { archivedAt: began, syncedAt: began },
                })
              ).count;
        cursor.totals[step === "contacts" ? "contacts" : "links"].archived += archived;
        advance();
        continue;
      }
      const page = await read({
        operation: "roleMail",
        ...pinned,
        crmRoleId: crmRoleId!,
        limit: PAGE,
        offset,
      });
      if (page.operation !== "roleMail") throw new ORPCError("SERVICE_UNAVAILABLE");
      if (!page.supported)
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message:
            "Required CRM role correspondence is unavailable. Enable the source capability before retrying this sync phase.",
        });
      recruiting.addCrmSyncCounts(
        cursor.totals.messages,
        await recruiting.syncRecruitingCrmMessages(
          prisma,
          actor,
          scope,
          page.items.map((item) => ({
            crmMessageId: item.id,
            crmCandidateId: item.candidateId,
            crmRoleId: crmRoleId!,
            threadId: item.threadId,
            direction: item.direction,
            sender: item.sender,
            recipients: item.recipients,
            subject: item.subject,
            body: item.body,
            sentAt: item.date ? new Date(item.date) : null,
          })),
          write,
        ),
      );
      if (page.nextOffset !== null && page.items.length) cursor.at.offset = page.nextOffset;
      else advance();
    } catch (error) {
      // Mail is a required phase. Preserve the current token and offset on any failure;
      // a retry must read the same page rather than report an incomplete sync as complete.
      if (step === "mail") throw error;
      const reason = readFailure(error);
      if (reason === null) throw error;
      // A failed read leaves this unit's rows exactly as they were: nothing is archived.
      skip(cursor, { organizationId: org.o, crmRoleId, step, reason });
      advance();
    }
  }
  const done = cursor.at.g >= cursor.orgs.length;
  const token = done ? null : randomUUID();
  if (token)
    await prisma.recruitingCrmSyncProgress.upsert({
      where: { userId_spaceId: owner },
      create: { ...owner, targetKey, token, progress: cursor },
      update: { targetKey, token, progress: cursor },
    });
  else await prisma.recruitingCrmSyncProgress.deleteMany({ where: owner });
  return {
    dryRun,
    startedAt: cursor.startedAt,
    nextCursor: token,
    organizations: cursor.orgs.length,
    ...cursor.totals,
    skipped: cursor.skipped as Skipped[],
  };
}

/** First call: lists organizations and syncs each one's complete role list. */
async function start(
  prisma: PrismaClient,
  actor: Actor,
  read: CrmRead,
  dryRun: boolean,
  now: Date,
  skip: (cursor: Cursor, entry: Skipped) => void,
): Promise<Cursor> {
  const cursor: Cursor = {
    v: 1,
    dryRun,
    startedAt: now.toISOString(),
    orgs: [],
    at: { g: 0, step: "contacts", j: 0, offset: 0, matched: 0, seen: [] },
    totals: {
      roles: recruiting.emptyCrmSyncCounts(),
      contacts: recruiting.emptyCrmSyncCounts(),
      links: recruiting.emptyCrmSyncCounts(),
      messages: recruiting.emptyCrmSyncCounts(),
      campaigns: recruiting.emptyCrmSyncCounts(),
      leads: recruiting.emptyCrmSyncCounts(),
    },
    skipped: [],
  };
  const memberships = await read({ operation: "memberships" });
  if (memberships.operation !== "memberships") throw new ORPCError("SERVICE_UNAVAILABLE");
  for (const source of memberships.sources) {
    if (source.status !== "ready") {
      skip(cursor, {
        organizationId: null,
        crmRoleId: null,
        step: "organizations",
        reason: `${source.name} could not be read.`,
      });
      continue;
    }
    for (const membership of source.memberships) {
      const pinned = {
        serverId: source.serverId,
        serverRevision: source.serverRevision,
        organizationId: membership.organizationId,
      };
      try {
        const roles = await read({ operation: "roles", ...pinned });
        if (roles.operation !== "roles") throw new ORPCError("SERVICE_UNAVAILABLE");
        recruiting.addCrmSyncCounts(
          cursor.totals.roles,
          await recruiting.syncRecruitingCrmRoles(
            prisma,
            actor,
            { mcpServerId: source.serverId, organizationId: membership.organizationId },
            roles.items.map((role) => ({
              crmRoleId: role.crmRoleId,
              clientId: role.clientId,
              clientLabel: role.clientLabel,
              roleLabel: role.roleLabel,
              summary: role.summary,
              organizationName: membership.name,
            })),
            { dryRun, now, complete: true },
          ),
        );
        cursor.orgs.push({
          s: source.serverId,
          r: source.serverRevision,
          o: membership.organizationId,
          roles: [...new Set(roles.items.map((role) => role.crmRoleId))],
        });
      } catch (error) {
        const reason = readFailure(error);
        if (reason === null) throw error;
        skip(cursor, {
          organizationId: membership.organizationId,
          crmRoleId: null,
          step: "roles",
          reason,
        });
      }
    }
  }
  return cursor;
}

/**
 * Incremental sync: the role list read that `roleCandidates` already made is written to the same
 * rows. Offset pages cannot prove absence, so only a full sync with exact-ID checks archives.
 */
export async function recordCrmRoleRead(
  database: PrismaClient,
  actor: Actor,
  read: {
    serverId: string;
    organizationId: string;
    role: NonNullable<
      Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["selectedRole"]
    >;
    items: Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"];
    complete: boolean;
  },
  now = new Date(),
) {
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actor.userId, actor.spaceId, "crm-sync"])}, 0))`;
      const prisma = tx as PrismaClient;
      const scope = { mcpServerId: read.serverId, organizationId: read.organizationId };
      const write = { dryRun: false, now };
      await recruiting.syncRecruitingCrmRoles(
        prisma,
        actor,
        scope,
        [
          {
            crmRoleId: read.role.crmRoleId,
            clientId: read.role.clientId,
            clientLabel: read.role.clientLabel,
            roleLabel: read.role.roleLabel,
            summary: read.role.summary,
          },
        ],
        { ...write, complete: false },
      );
      await recruiting.syncRecruitingCrmContacts(
        prisma,
        actor,
        scope,
        read.items.map(crmSyncContact),
        write,
      );
      await recruiting.syncRecruitingCrmRoleLinks(
        prisma,
        actor,
        scope,
        read.role.crmRoleId,
        read.items.map((item) => item.candidateId),
        write,
      );
      // Only the full sync performs exact-ID absence verification and archives links.
    },
    { timeout: 120_000, maxWait: 5_000 },
  );
}
