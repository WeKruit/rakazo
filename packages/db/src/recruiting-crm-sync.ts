import { isDeepStrictEqual } from "node:util";
import type { Actor, RecruitingCrmDataOutput, RecruitingCrmSyncCounts } from "@rakazo/contracts";
import { RecruitingCrmProfileSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

/** One CRM organization of one CRM connection, as the acting user sees it. */
export type CrmSyncScope = { mcpServerId: string; organizationId: string };
export type CrmSyncRole = {
  crmRoleId: string;
  clientId: string;
  clientLabel: string;
  roleLabel: string;
  summary: string | null;
  /** Omitted when the read did not include it, keeping the stored name. */
  organizationName?: string | null;
};
export type CrmSyncContact = {
  crmCandidateId: string;
  name: string;
  title: string | null;
  company?: string | null;
  profile?: Extract<
    RecruitingCrmDataOutput,
    { operation: "candidates" }
  >["items"][number]["profile"];
  location: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  identityKey: string | null;
  stage: string | null;
  contactStatus: string;
  outreachStatus: string;
  interest: string | null;
  reviewed: boolean | null;
  lastReplyAt: Date | null;
  resumeReceived: boolean | null;
  crmRoleId: string | null;
  clientLabel: string;
  roleLabel: string;
};
export type CrmSyncMessage = {
  crmMessageId: string;
  crmCandidateId: string;
  crmRoleId: string;
  threadId: string | null;
  direction: string | null;
  sender: string | null;
  recipients: string[];
  subject: string | null;
  body: string | null;
  sentAt: Date | null;
};
type Options = { dryRun: boolean; now: Date };

export const emptyCrmSyncCounts = (): RecruitingCrmSyncCounts => ({
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  restored: 0,
});
export function addCrmSyncCounts(into: RecruitingCrmSyncCounts, add: RecruitingCrmSyncCounts) {
  for (const key of Object.keys(into) as (keyof RecruitingCrmSyncCounts)[]) into[key] += add[key];
  return into;
}

const owned = (actor: Actor, scope: CrmSyncScope) => ({
  userId: actor.userId,
  spaceId: actor.spaceId,
  mcpServerId: scope.mcpServerId,
  organizationId: scope.organizationId,
});
const same = (left: unknown, right: unknown) =>
  left instanceof Date || right instanceof Date
    ? (left instanceof Date ? left.getTime() : left) ===
      (right instanceof Date ? right.getTime() : right)
    : isDeepStrictEqual(left, right);
const changed = <T extends Record<string, unknown>>(stored: Record<string, unknown>, next: T) =>
  (Object.keys(next) as (keyof T & string)[]).some((key) => !same(stored[key], next[key]));
const lastBy = <T>(rows: T[], key: (row: T) => string) => [
  ...new Map(rows.map((row) => [key(row), row])).values(),
];

/**
 * Upserts rows keyed by their CRM id inside one owner scope. Unchanged rows only get `syncedAt`
 * touched, so a later "not seen since" archive pass can find what disappeared from the CRM.
 */
async function upsertKeyed<T extends Record<string, unknown>>(
  delegate: {
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    createMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  },
  where: Record<string, unknown>,
  keyField: string,
  rows: T[],
  options: Options & { archivable: boolean },
): Promise<RecruitingCrmSyncCounts> {
  const counts = emptyCrmSyncCounts();
  const unique = lastBy(rows, (row) => String(row[keyField]));
  counts.seen = unique.length;
  if (!unique.length) return counts;
  const stored = new Map(
    (
      await delegate.findMany({
        where: { ...where, [keyField]: { in: unique.map((row) => row[keyField]) } },
      })
    ).map((row) => [String(row[keyField]), row]),
  );
  const create: T[] = [];
  const touch: string[] = [];
  for (const row of unique) {
    const existing = stored.get(String(row[keyField]));
    if (!existing) {
      create.push(row);
      counts.created++;
      continue;
    }
    // A newer read wins even if an older, paged pass finishes later.
    if (
      (existing.syncedAt instanceof Date && existing.syncedAt > options.now) ||
      (existing.archivedAt instanceof Date && existing.archivedAt >= options.now)
    ) {
      counts.unchanged++;
      continue;
    }
    const restored = options.archivable && existing.archivedAt != null;
    if (!restored && !changed(existing, row)) {
      counts.unchanged++;
      touch.push(String(existing.id));
      continue;
    }
    if (restored) counts.restored++;
    else counts.updated++;
    if (!options.dryRun)
      await delegate.updateMany({
        where: {
          id: existing.id,
          syncedAt: { lte: options.now },
          ...(options.archivable
            ? { OR: [{ archivedAt: null }, { archivedAt: { lt: options.now } }] }
            : {}),
        },
        data: {
          ...row,
          syncedAt: options.now,
          ...(options.archivable ? { archivedAt: null } : {}),
        },
      });
  }
  if (options.dryRun) return counts;
  if (create.length)
    await delegate.createMany({
      data: create.map((row) => ({ ...where, ...row, syncedAt: options.now })),
      skipDuplicates: true,
    });
  if (touch.length)
    await delegate.updateMany({
      where: { id: { in: touch }, syncedAt: { lt: options.now } },
      data: { syncedAt: options.now },
    });
  return counts;
}

/** With the organization's complete role list, missing roles are archived, never deleted. */
export async function syncRecruitingCrmRoles(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  roles: CrmSyncRole[],
  options: Options & { complete: boolean },
) {
  const where = owned(actor, scope);
  const counts = await upsertKeyed(prisma.recruitingCrmRole, where, "crmRoleId", roles, {
    ...options,
    archivable: true,
  });
  if (!options.complete) return counts;
  const gone = {
    ...where,
    archivedAt: null,
    crmRoleId: { notIn: roles.map((role) => role.crmRoleId) },
    syncedAt: { lte: options.now },
  };
  counts.archived = options.dryRun
    ? await prisma.recruitingCrmRole.count({ where: gone })
    : (
        await prisma.recruitingCrmRole.updateMany({
          where: gone,
          data: { archivedAt: options.now, syncedAt: options.now },
        })
      ).count;
  return counts;
}

/** Upserts a page of contacts; archiving needs a complete pass (see archive below). */
export function syncRecruitingCrmContacts(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  contacts: CrmSyncContact[],
  options: Options,
) {
  return upsertKeyed(prisma.recruitingCrmContact, owned(actor, scope), "crmCandidateId", contacts, {
    ...options,
    archivable: true,
  });
}

/**
 * After a complete organization pass that started at `since`, archives contacts it did not see.
 * A dry run cannot mark rows, so it reports active stored contacts minus those the pass matched.
 */
export async function archiveUnseenRecruitingCrmContacts(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  since: Date,
  options: Options & { matchedStored: number },
) {
  const where = { ...owned(actor, scope), archivedAt: null };
  if (options.dryRun)
    return Math.max(
      0,
      (await prisma.recruitingCrmContact.count({ where })) - options.matchedStored,
    );
  return (
    await prisma.recruitingCrmContact.updateMany({
      where: { ...where, syncedAt: { lt: since } },
      data: { archivedAt: options.now, syncedAt: options.now },
    })
  ).count;
}

/** Links one page of a role's contacts (which must already be synced) to that role. */
export async function syncRecruitingCrmRoleLinks(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  crmRoleId: string,
  crmCandidateIds: string[],
  options: Options,
): Promise<RecruitingCrmSyncCounts> {
  const counts = emptyCrmSyncCounts();
  const ids = [...new Set(crmCandidateIds)];
  counts.seen = ids.length;
  const role = await prisma.recruitingCrmRole.findUnique({
    where: {
      userId_spaceId_mcpServerId_organizationId_crmRoleId: { ...owned(actor, scope), crmRoleId },
    },
    select: { id: true },
  });
  const contacts = await prisma.recruitingCrmContact.findMany({
    where: { ...owned(actor, scope), crmCandidateId: { in: ids } },
    select: { id: true },
  });
  const links = role
    ? await prisma.recruitingCrmRoleContact.findMany({
        where: { roleId: role.id, contactId: { in: contacts.map((contact) => contact.id) } },
      })
    : [];
  const stored = new Map(links.map((link) => [link.contactId, link]));
  const create: string[] = [];
  const touch: string[] = [];
  const restore: string[] = [];
  // A dry run has not created the new contacts yet; a real run links only stored contacts.
  if (options.dryRun) counts.created = ids.length - contacts.length;
  for (const contact of contacts) {
    const link = stored.get(contact.id);
    if (!link) create.push(contact.id);
    else if (link.archivedAt) restore.push(contact.id);
    else touch.push(contact.id);
  }
  counts.created += create.length;
  counts.restored = restore.length;
  counts.unchanged = touch.length;
  if (options.dryRun || !role) return counts;
  if (create.length)
    await prisma.recruitingCrmRoleContact.createMany({
      data: create.map((contactId) => ({ roleId: role.id, contactId, syncedAt: options.now })),
      skipDuplicates: true,
    });
  if (touch.length || restore.length)
    await prisma.recruitingCrmRoleContact.updateMany({
      where: {
        roleId: role.id,
        contactId: { in: [...touch, ...restore] },
        syncedAt: { lte: options.now },
        OR: [{ archivedAt: null }, { archivedAt: { lt: options.now } }],
      },
      data: { syncedAt: options.now, archivedAt: null },
    });
  return counts;
}

/** After a complete pass of one role's contacts, archives the links it did not see. */
export async function archiveUnseenRecruitingCrmRoleLinks(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  crmRoleId: string,
  since: Date,
  options: Options & { matchedStored: number },
) {
  const role = await prisma.recruitingCrmRole.findUnique({
    where: {
      userId_spaceId_mcpServerId_organizationId_crmRoleId: { ...owned(actor, scope), crmRoleId },
    },
    select: { id: true },
  });
  if (!role) return 0;
  const where = { roleId: role.id, archivedAt: null };
  if (options.dryRun)
    return Math.max(
      0,
      (await prisma.recruitingCrmRoleContact.count({ where })) - options.matchedStored,
    );
  return (
    await prisma.recruitingCrmRoleContact.updateMany({
      where: { ...where, syncedAt: { lt: since } },
      data: { archivedAt: options.now, syncedAt: options.now },
    })
  ).count;
}

export function syncRecruitingCrmMessages(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  messages: CrmSyncMessage[],
  options: Options,
) {
  return upsertKeyed(prisma.recruitingCrmMessage, owned(actor, scope), "crmMessageId", messages, {
    ...options,
    archivable: false,
  });
}

/** Authorized caller must fence its live connection/revision before reading this scoped projection. */
export async function listSyncedRecruitingCrmRoleContacts(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  crmRoleId: string,
): Promise<Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"] | null> {
  const owner = owned(actor, scope);
  // No synced role is unknown coverage, not a verified empty candidate list.
  const role = await prisma.recruitingCrmRole.findFirst({
    where: { ...owner, crmRoleId, archivedAt: null },
    select: { id: true },
  });
  if (!role) return null;
  const links = await prisma.recruitingCrmRoleContact.findMany({
    where: {
      archivedAt: null,
      role: { ...owner, crmRoleId, archivedAt: null },
      contact: { ...owner, archivedAt: null },
    },
    include: { contact: true },
    orderBy: { contactId: "asc" },
  });
  return links.map(({ contact }) => ({
    candidateId: contact.crmCandidateId,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    linkedinUrl: contact.linkedinUrl,
    location: contact.location,
    title: contact.title,
    company: contact.company,
    stage: contact.stage,
    contactStatus: contact.contactStatus,
    outreachStatus: contact.outreachStatus,
    roleSpecId: contact.crmRoleId,
    legacyClientLabel: contact.clientLabel,
    legacyRoleLabel: contact.roleLabel,
    interest: contact.interest,
    reviewed: contact.reviewed,
    lastReplyAt: contact.lastReplyAt?.toISOString() ?? null,
    resumeReceived: contact.resumeReceived,
    ...(contact.profile === null
      ? {}
      : { profile: RecruitingCrmProfileSchema.parse(contact.profile) }),
  }));
}

export type CrmSyncCampaign = {
  crmCampaignId: string;
  name: string;
  status: number | null;
  crmRoleId: string | null;
  clientId: string | null;
  campaignCreatedAt: Date | null;
  campaignUpdatedAt: Date | null;
  mirrorSyncedAt: Date;
};
export type CrmSyncLead = {
  crmLeadId: string;
  /** null when the source sequence no longer exists. */
  crmCampaignId: string | null;
  crmCandidateId: string | null;
  status: number | null;
  interestStatus: number | null;
  openCount: number | null;
  replyCount: number | null;
  lastContactAt: Date | null;
  lastReplyAt: Date | null;
  mirrorSyncedAt: Date;
};

/** Upserts stored campaigns. Offset pages cannot prove absence, so nothing is archived here. */
export function syncRecruitingCrmCampaigns(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  campaigns: CrmSyncCampaign[],
  options: Options,
) {
  return upsertKeyed(
    prisma.recruitingCrmCampaign,
    owned(actor, scope),
    "crmCampaignId",
    campaigns,
    {
      ...options,
      archivable: false,
    },
  );
}

/** Upserts one campaign's stored lead stats; same no-archive rule as campaigns. */
export function syncRecruitingCrmLeads(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  leads: CrmSyncLead[],
  options: Options,
) {
  return upsertKeyed(prisma.recruitingCrmLead, owned(actor, scope), "crmLeadId", leads, {
    ...options,
    archivable: false,
  });
}

export const sequenceStatus = (code: number | null) =>
  code === null
    ? null
    : code === 0
      ? ("draft" as const)
      : code === 1 || code === 4
        ? ("active" as const)
        : code === 2
          ? ("paused" as const)
          : code === 3
            ? ("completed" as const)
            : ("stopped" as const);
const leadStatus = (code: number | null) =>
  code === 1
    ? ("active" as const)
    : code === 2
      ? ("paused" as const)
      : code === 3
        ? ("completed" as const)
        : code === -1
          ? ("bounced" as const)
          : code === -2
            ? ("unsubscribed" as const)
            : code === -3
              ? ("skipped" as const)
              : null;
const latest = (values: (Date | null)[]) =>
  values.reduce<Date | null>(
    (best, value) => (value && (!best || value > best) ? value : best),
    null,
  );
const total = (values: (number | null)[]) =>
  values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0)
    : null;

export type SequenceLead = {
  crmLeadId: string;
  crmCampaignId: string | null;
  crmCandidateId: string | null;
  status: number | null;
  openCount: number | null;
  replyCount: number | null;
  lastContactAt: Date | null;
  lastReplyAt: Date | null;
  syncedAt: Date;
};

/** Per-person sequence numbers across every sequence, from that person's leads. */
export function sequenceStatsFromLeads(leads: SequenceLead[]) {
  const byCandidate = new Map<string, SequenceLead[]>();
  for (const lead of leads) {
    if (!lead.crmCandidateId) continue;
    const rows = byCandidate.get(lead.crmCandidateId) ?? [];
    rows.push(lead);
    byCandidate.set(lead.crmCandidateId, rows);
  }
  return [...byCandidate].map(([candidateId, rows]) => {
    // The person's current state is the one in the sequence that contacted them last.
    const current = [...rows].sort(
      (a, b) => (b.lastContactAt?.getTime() ?? 0) - (a.lastContactAt?.getTime() ?? 0),
    )[0]!;
    return {
      candidateId,
      // A lead whose sequence was deleted still was one sequence.
      sequences: new Set(rows.map((row) => row.crmCampaignId ?? row.crmLeadId)).size,
      opens: total(rows.map((row) => row.openCount)),
      replies: total(rows.map((row) => row.replyCount)),
      lastContactAt: latest(rows.map((row) => row.lastContactAt))?.toISOString() ?? null,
      lastReplyAt: latest(rows.map((row) => row.lastReplyAt))?.toISOString() ?? null,
      status: leadStatus(current.status),
      syncedAt: latest(rows.map((row) => row.syncedAt))!.toISOString(),
    };
  });
}

/** Saved per-person sequence numbers across every synced sequence, for the listed people. */
export async function listSyncedRecruitingSequenceStats(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
  candidateIds: string[],
) {
  const leads = await prisma.recruitingCrmLead.findMany({
    where: { ...owned(actor, scope), archivedAt: null, crmCandidateId: { in: candidateIds } },
    orderBy: { crmLeadId: "asc" },
  });
  return sequenceStatsFromLeads(leads);
}

/** Saved sequences with no role, with how many people each reached, opened and replied. */
export async function listSyncedRecruitingUnassignedSequences(
  prisma: PrismaClient,
  actor: Actor,
  scope: CrmSyncScope,
) {
  const owner = owned(actor, scope);
  const campaigns = await prisma.recruitingCrmCampaign.findMany({
    where: { ...owner, archivedAt: null, crmRoleId: null },
    orderBy: [{ campaignUpdatedAt: { sort: "desc", nulls: "last" } }, { crmCampaignId: "asc" }],
    take: 200,
  });
  const leads = campaigns.length
    ? await prisma.recruitingCrmLead.findMany({
        where: {
          ...owner,
          archivedAt: null,
          crmCampaignId: { in: campaigns.map((row) => row.crmCampaignId) },
        },
        select: { crmCampaignId: true, openCount: true, replyCount: true, lastContactAt: true },
      })
    : [];
  return campaigns.map((campaign) => {
    const rows = leads.filter((lead) => lead.crmCampaignId === campaign.crmCampaignId);
    return {
      id: campaign.crmCampaignId,
      name: campaign.name,
      status: sequenceStatus(campaign.status),
      people: rows.length,
      opened: rows.filter((row) => (row.openCount ?? 0) > 0).length,
      replied: rows.filter((row) => (row.replyCount ?? 0) > 0).length,
      lastContactAt: latest(rows.map((row) => row.lastContactAt))?.toISOString() ?? null,
      syncedAt: campaign.syncedAt.toISOString(),
    };
  });
}
