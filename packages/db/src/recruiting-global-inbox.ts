import { createHash } from "node:crypto";
import type {
  Actor,
  GlobalRecruitingInboxInput,
  GlobalRecruitingInboxOutput,
  RecruitingCorrespondence,
  RecruitingRoleCandidate,
} from "@rakazo/contracts";
import {
  GlobalRecruitingInboxInputSchema,
  inboxMessageKey,
  inboxThreadKey,
  RecruitingCorrespondenceSchema,
  RecruitingCrmProfileSchema,
  RecruitingHistoryImportSchema,
  RecruitingRoleCandidateSchema,
  recruitingCandidateRanking,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import { candidateIndexQuery } from "./recruiting.js";
import { listRecruitingSavedProfiles } from "./recruiting-saved-profiles.js";
import { IsolationError } from "./scope.js";

type Email = RecruitingCorrespondence["emails"][number];
type Tx = Prisma.TransactionClient;
const emailSchema = RecruitingCorrespondenceSchema.shape.emails.element;
const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const date = (value: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const owned = (actor: Actor) => ({ userId: actor.userId, spaceId: actor.spaceId });
const safeLike = (value: string) => `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const inboxMessageDedupeKey = inboxMessageKey;

async function requireRole(tx: Tx, actor: Actor, roleId: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT r.id FROM recruiting_roles r JOIN threads t ON t.id=r."sourceThreadId"
    WHERE r.id=${roleId} AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL
    AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId} AND t."activeRecruitingRoleId"=r.id FOR SHARE OF r,t`;
  if (!rows.length) throw new IsolationError();
}

async function put(
  tx: Tx,
  actor: Actor,
  input: {
    roleId: string;
    email: Email;
    observedAt: Date;
    kind: "observed" | "import" | "crm";
    receiptId?: string;
    ordinal?: number;
    person?: RecruitingRoleCandidate;
    organizationId?: string | null;
  },
) {
  const email = emailSchema.parse(input.email);
  const organizationId = input.organizationId ?? email.crm?.organizationId ?? null;
  const originKey = JSON.stringify([email.sourceId, organizationId, email.id]);
  const id = hash([
    actor.userId,
    actor.spaceId,
    input.roleId,
    input.kind,
    input.receiptId ?? originKey,
    input.ordinal ?? 0,
  ]);
  const thread =
    email.sourceId && email.providerThreadId && email.eaccount
      ? inboxThreadKey({
          sourceId: email.sourceId,
          organizationId,
          mailbox: email.eaccount,
          threadId: email.providerThreadId,
        })
      : null;
  const search = [email.subject, email.sender, ...email.recipients, email.body, email.eaccount]
    .filter(Boolean)
    .join("\n");
  await tx.$executeRaw`INSERT INTO recruiting_inbox_messages
    (id,user_id,space_id,role_id,origin_key,dedupe_key,thread_key,source_id,organization_id,source_kind,receipt_id,receipt_ordinal,observed_at,message_at,direction,search_text,email,person)
    VALUES (${id},${actor.userId},${actor.spaceId},${input.roleId},${originKey},${inboxMessageDedupeKey(email, organizationId)},${thread},${email.sourceId},${organizationId},${input.kind},${input.receiptId ?? null},${input.ordinal ?? null},${input.observedAt},${date(email.date)},${email.direction ?? email.crm?.direction ?? null},${search},${JSON.stringify(email)}::jsonb,${input.person ? JSON.stringify(input.person) : null}::jsonb)
    ON CONFLICT (id) DO UPDATE SET dedupe_key=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.dedupe_key WHEN EXCLUDED.source_kind='observed' AND (EXCLUDED.email->>'eaccount') IS NULL THEN recruiting_inbox_messages.dedupe_key ELSE EXCLUDED.dedupe_key END,thread_key=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.thread_key WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.thread_key,recruiting_inbox_messages.thread_key) ELSE EXCLUDED.thread_key END,source_id=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.source_id ELSE EXCLUDED.source_id END,observed_at=GREATEST(recruiting_inbox_messages.observed_at,EXCLUDED.observed_at),message_at=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.message_at WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.message_at,recruiting_inbox_messages.message_at) ELSE EXCLUDED.message_at END,direction=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.direction WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.direction,recruiting_inbox_messages.direction) ELSE EXCLUDED.direction END,search_text=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.search_text WHEN EXCLUDED.source_kind='observed' AND COALESCE((EXCLUDED.email->>'snippet')::boolean,false) AND NOT COALESCE((recruiting_inbox_messages.email->>'snippet')::boolean,false) THEN recruiting_inbox_messages.search_text ELSE EXCLUDED.search_text END,email=(CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.email WHEN EXCLUDED.source_kind='observed' AND COALESCE((EXCLUDED.email->>'snippet')::boolean,false) AND NOT COALESCE((recruiting_inbox_messages.email->>'snippet')::boolean,false)
      THEN recruiting_inbox_messages.email || EXCLUDED.email || jsonb_build_object('body',recruiting_inbox_messages.email->'body','snippet',false,'date',COALESCE(NULLIF(EXCLUDED.email->'date','null'::jsonb),recruiting_inbox_messages.email->'date'),'direction',COALESCE(NULLIF(EXCLUDED.email->'direction','null'::jsonb),recruiting_inbox_messages.email->'direction')) ELSE EXCLUDED.email END)
      || CASE WHEN EXCLUDED.source_kind='observed' AND (recruiting_inbox_messages.email ? 'attachments' OR EXCLUDED.email ? 'attachments') THEN jsonb_build_object('attachments', (SELECT COALESCE(jsonb_agg(file),'[]'::jsonb) FROM (SELECT DISTINCT ON (file->>'id') file FROM jsonb_array_elements(CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN COALESCE(EXCLUDED.email->'attachments','[]'::jsonb)||COALESCE(recruiting_inbox_messages.email->'attachments','[]'::jsonb) ELSE COALESCE(recruiting_inbox_messages.email->'attachments','[]'::jsonb)||COALESCE(EXCLUDED.email->'attachments','[]'::jsonb) END) WITH ORDINALITY files(file,ordinal) ORDER BY file->>'id',ordinal DESC) exact_attachments)) ELSE '{}'::jsonb END,
      person=CASE WHEN recruiting_inbox_messages.observed_at > EXCLUDED.observed_at THEN recruiting_inbox_messages.person ELSE COALESCE(EXCLUDED.person,recruiting_inbox_messages.person) END
    WHERE recruiting_inbox_messages.observed_at <= EXCLUDED.observed_at OR (EXCLUDED.source_kind='observed' AND EXCLUDED.email ? 'attachments')`;
}

/** A display projection of an already authorized canonical read, never new provider authority. */
export async function projectRecruitingInboxMessages(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    roleId: string;
    emails: readonly Email[];
    observedAt: Date;
    people?: readonly RecruitingRoleCandidate[];
  },
  authorize?: () => Promise<void>,
) {
  await prisma.$transaction(async (tx) => {
    await requireRole(tx, actor, input.roleId);
    for (const email of input.emails) {
      const people = input.people ?? [];
      const person = email.crm
        ? people.find(
            (candidate) =>
              candidate.crm?.serverId === email.sourceId &&
              candidate.crm?.organizationId === email.crm?.organizationId &&
              candidate.crm?.candidateId === email.crm?.candidateId,
          )
        : email.candidateKey
          ? people.find((candidate) => candidate.autumn?.candidateKey === email.candidateKey)
          : undefined;
      await put(tx, actor, { ...input, email, kind: "observed", person });
    }
    await authorize?.();
  });
}

/** Missing receipt rows, not fabricated progress records, form the bounded backfill cursor. */
async function backfill(tx: Tx, actor: Actor) {
  const batchSize = 500;
  const people = new Map<string, RecruitingRoleCandidate | null>();
  const imports = await tx.$queryRaw<
    {
      roleId: string;
      receiptId: string;
      ordinal: bigint;
      createdAt: Date;
      email: unknown;
      metadata: unknown;
    }[]
  >`
    WITH receipts AS MATERIALIZED (
    SELECT r.id AS "roleId",e.id AS "receiptId",e."createdAt",jsonb_build_object('version',e.result->'version','roleId',e.result->'roleId','sourceSha256',e.result->'sourceSha256','importedAt',e.result->'importedAt') AS metadata,
      CASE WHEN jsonb_typeof(e.result->'emails')='array' THEN e.result->'emails' ELSE '[]'::jsonb END AS emails
    FROM external_effects e JOIN runs run ON run.id=e."runId" JOIN bots b ON b.id=run."botId"
    JOIN recruiting_role_revisions rev ON rev.id=run."initialRecruitingRoleRevisionId"
    JOIN recruiting_roles r ON r.id=rev."roleId" JOIN threads t ON t.id=run."threadId"
    WHERE e."spaceId"=${actor.spaceId} AND e.kind='recruiting_history_import' AND e.status='completed'
      AND run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND run.trigger='tool_background' AND run.status='completed'
      AND b."userId"=${actor.userId} AND b."spaceId"=${actor.spaceId} AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId}
      AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL AND t."activeRecruitingRoleId"=r.id
      AND e.request->>'roleId'=r.id AND e.result->>'roleId'=r.id
    ) SELECT receipt."roleId",receipt."receiptId",mail.ordinality AS ordinal,receipt."createdAt",mail.value AS email,receipt.metadata
    FROM receipts receipt CROSS JOIN LATERAL jsonb_array_elements(receipt.emails) WITH ORDINALITY AS mail
    WHERE NOT EXISTS (SELECT 1 FROM recruiting_inbox_messages seen WHERE seen.user_id=${actor.userId} AND seen.space_id=${actor.spaceId} AND seen.receipt_id=receipt."receiptId" AND seen.receipt_ordinal=mail.ordinality)
    ORDER BY receipt."createdAt",receipt."receiptId",mail.ordinality LIMIT ${batchSize + 1}`;
  for (const row of imports.slice(0, batchSize)) {
    RecruitingHistoryImportSchema.pick({
      version: true,
      roleId: true,
      sourceSha256: true,
      importedAt: true,
    }).parse(row.metadata);
    const email = emailSchema.parse(row.email);
    if (email.savedRead || email.crm) throw new Error("Imported mail has live provider authority");
    await put(tx, actor, {
      roleId: row.roleId,
      receiptId: row.receiptId,
      ordinal: Number(row.ordinal),
      observedAt: row.createdAt,
      email: { ...email, imported: true },
      kind: "import",
    });
  }
  // Existing mirror ownership and exact role attachment supply provenance; missing mailbox stays unknown.
  const mirrors = await tx.$queryRaw<
    {
      roleId: string;
      id: string;
      sourceId: string;
      sourceName: string;
      organizationId: string;
      candidateId: string;
      messageId: string;
      providerThreadId: string | null;
      direction: string | null;
      sender: string | null;
      recipients: unknown;
      subject: string | null;
      body: string | null;
      sentAt: Date | null;
      syncedAt: Date;
    }[]
  >`
    SELECT r.id AS "roleId",m.id,m."mcpServerId" AS "sourceId",s.name AS "sourceName",m."organizationId",m."crmCandidateId" AS "candidateId",m."crmMessageId" AS "messageId",m."threadId" AS "providerThreadId",m.direction,m.sender,m.recipients,m.subject,m.body,m."sentAt",m."syncedAt"
    FROM recruiting_crm_messages m JOIN mcp_servers s ON s.id=m."mcpServerId"
    JOIN recruiting_roles r ON r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL
    JOIN threads t ON t.id=r."sourceThreadId"
    LEFT JOIN recruiting_crm_workspace_attachments a ON a."roleId"=r.id AND a."userId"=${actor.userId} AND a."spaceId"=${actor.spaceId}
    LEFT JOIN external_effects binding ON binding.id=r."crmBindingEffectId" AND binding."spaceId"=${actor.spaceId} AND binding.kind='recruiting_crm_target' AND binding.status='completed'
    WHERE m."userId"=${actor.userId} AND m."spaceId"=${actor.spaceId} AND s."userId"=${actor.userId} AND s."spaceId"=${actor.spaceId}
      AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId} AND t."activeRecruitingRoleId"=r.id
      AND ((a."roleId" IS NOT NULL AND a."mcpServerId"=m."mcpServerId" AND a."organizationId"=m."organizationId" AND a."crmRoleId"=m."crmRoleId")
        OR (a."roleId" IS NULL AND binding.result->>'roleId'=r.id AND binding.result->'target'->>'mcpServerId'=m."mcpServerId" AND binding.result->'target'->>'organizationId'=m."organizationId" AND binding.result->'target'->>'crmRoleId'=m."crmRoleId"))
      AND NOT EXISTS (SELECT 1 FROM recruiting_inbox_messages seen WHERE seen.user_id=${actor.userId} AND seen.space_id=${actor.spaceId} AND seen.role_id=r.id AND seen.source_kind='crm' AND seen.receipt_id=m.id AND seen.observed_at>=m."syncedAt")
    ORDER BY m."syncedAt",m.id,r.id LIMIT ${batchSize + 1}`;
  for (const row of mirrors.slice(0, batchSize)) {
    const personKey = JSON.stringify([row.sourceId, row.organizationId, row.candidateId]);
    if (!people.has(personKey))
      people.set(
        personKey,
        await savedPerson(tx, actor, row.roleId, { sourceId: row.sourceId }, null, {
          organizationId: row.organizationId,
          candidateId: row.candidateId,
        }),
      );
    await put(tx, actor, {
      roleId: row.roleId,
      organizationId: row.organizationId,
      receiptId: row.id,
      observedAt: row.syncedAt,
      kind: "crm",
      person: people.get(personKey) ?? undefined,
      email: {
        id: JSON.stringify([row.sourceId, row.organizationId, row.candidateId, row.messageId]),
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        providerMessageId: row.messageId,
        providerThreadId: row.providerThreadId,
        savedRead: null,
        sender: row.sender,
        recipients: zRecipients(row.recipients),
        subject: row.subject ?? "",
        body: row.body ?? "",
        snippet: row.body === null,
        date: row.sentAt?.toISOString() ?? null,
        direction:
          row.direction === "sent" || row.direction === "received" || row.direction === "manual"
            ? row.direction
            : null,
        url: null,
      },
    });
  }
  return { importsComplete: imports.length <= batchSize, crmComplete: mirrors.length <= batchSize };
}
/** One bounded background chunk; display reads never invoke it. */
export async function indexRecruitingInboxBatch(
  prisma: PrismaClient,
  actor: Actor,
  authorize?: () => Promise<void>,
) {
  return prisma.$transaction(
    async (tx) => {
      await authorize?.();
      const coverage = await backfill(tx, actor);
      await tx.recruitingInboxIndexProgress.upsert({
        where: { userId_spaceId: owned(actor) },
        create: { ...owned(actor), ...coverage },
        update: { ...coverage, checkedAt: new Date() },
      });
      await authorize?.();
      return coverage;
    },
    { timeout: 60_000 },
  );
}

function zRecipients(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Reuse saved role rows and owned lookup profiles; never fetch a provider to decorate a card. */
async function savedPerson(
  tx: Tx,
  actor: Actor,
  roleId: string,
  email: Pick<Email, "sourceId" | "candidateKey" | "crm">,
  existing: unknown,
  crmIdentity?: { organizationId: string; candidateId: string },
): Promise<RecruitingRoleCandidate | null> {
  const supplied = existing ? RecruitingRoleCandidateSchema.parse(existing) : null;
  // Saved DTOs establish identity, never the current grade or role revision.
  const identity =
    crmIdentity ?? email.crm ?? (supplied?.crm?.serverId === email.sourceId ? supplied.crm : null);
  if (identity) {
    const contact = await tx.recruitingCrmContact.findFirst({
      where: {
        ...owned(actor),
        mcpServerId: email.sourceId,
        organizationId: identity.organizationId,
        crmCandidateId: identity.candidateId,
        archivedAt: null,
      },
    });
    if (!contact) return null;
    const profile = RecruitingCrmProfileSchema.safeParse(contact.profile);
    return RecruitingRoleCandidateSchema.parse({
      key: `crm:${contact.crmCandidateId}`,
      name: contact.name,
      title: contact.title,
      location: contact.location,
      email: contact.email,
      linkedinUrl: contact.linkedinUrl,
      autumn: null,
      shortlisted: false,
      shortlistedAt: null,
      crm: {
        serverId: contact.mcpServerId,
        organizationId: contact.organizationId,
        candidateId: contact.crmCandidateId,
        stage: contact.stage,
        contactStatus: contact.contactStatus,
        outreachStatus: contact.outreachStatus,
        phone: contact.phone,
        company: contact.company,
        ...(profile.success ? { profile: profile.data } : {}),
        interest: contact.interest,
        reviewed: contact.reviewed,
        lastReplyAt: contact.lastReplyAt?.toISOString() ?? null,
        resumeReceived: contact.resumeReceived,
      },
    });
  }
  const candidateKey = email.candidateKey ?? supplied?.autumn?.candidateKey;
  if (!candidateKey) return null;
  const candidates = await tx.$queryRaw<
    {
      candidateKey: string;
      name: string | null;
      title: string | null;
      location: string | null;
      linkedinUrl: string | null;
      shortlisted: boolean;
      shortlistedAt: string | null;
      reviewerRoleRevisionId: string | null;
      reviewerPageId: string | null;
      reviewerGrade: string | null;
      reviewerScore: number | null;
      providerPageId: string | null;
      providerScore: number | null;
      providerRoleRevisionId: string | null;
    }[]
  >(
    Prisma.sql`${candidateIndexQuery(roleId, "ranking")} SELECT * FROM base WHERE "candidateKey"=${candidateKey} LIMIT 1`,
  );
  const row = candidates[0];
  if (!row) return null;
  const role = await tx.recruitingRole.findUniqueOrThrow({
    where: { id: roleId },
    select: { currentRevisionId: true },
  });
  const profiles = await listRecruitingSavedProfiles(tx, actor, [row.candidateKey]);
  return RecruitingRoleCandidateSchema.parse({
    key: `autumn:${row.candidateKey}`,
    name: row.name,
    title: row.title,
    location: row.location,
    email: null,
    linkedinUrl: row.linkedinUrl,
    shortlisted: row.shortlisted,
    shortlistedAt: row.shortlistedAt,
    crm: null,
    autumn: {
      candidateKey: row.candidateKey,
      savedProfile: profiles.get(row.candidateKey) ?? null,
      ranking: recruitingCandidateRanking({
        source: row.reviewerRoleRevisionId
          ? "reviewer"
          : row.providerScore !== null
            ? "provider"
            : "none",
        roleRevisionId: row.reviewerRoleRevisionId ?? row.providerRoleRevisionId,
        sourceEffectId: row.reviewerPageId ?? row.providerPageId,
        currentRoleRevisionId: role.currentRevisionId,
        grade: row.reviewerGrade,
        score: row.reviewerRoleRevisionId
          ? row.reviewerScore === null
            ? null
            : Number(row.reviewerScore)
          : row.providerScore === null
            ? null
            : Number(row.providerScore),
      }),
      score: null,
      rank: null,
      tier: null,
      matchSummary: null,
      criteria: [],
    },
  });
}

/** Canonical corrections first; then the existing complete-body/live-source preference and aliases. */
function corpus(actor: Actor, includeFiles = true) {
  return Prisma.sql`WITH origins AS (
    SELECT DISTINCT ON (m.role_id,m.origin_key) m.* FROM recruiting_inbox_messages m
    JOIN recruiting_roles r ON r.id=m.role_id JOIN threads t ON t.id=r."sourceThreadId"
    WHERE m.user_id=${actor.userId} AND m.space_id=${actor.spaceId} AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL
      AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId} AND t."activeRecruitingRoleId"=r.id
      AND NOT EXISTS (SELECT 1 FROM chat_groups g WHERE g.id=t."groupId" AND g."archivedAt" IS NOT NULL)
    ORDER BY m.role_id,m.origin_key,(m.source_kind<>'crm') DESC,m.observed_at DESC,m.receipt_id DESC NULLS LAST,m.receipt_ordinal DESC NULLS LAST,m.id DESC
  ), preferred AS (
    SELECT DISTINCT ON (role_id,dedupe_key) * FROM origins
    ORDER BY role_id,dedupe_key,COALESCE((email->>'snippet')::boolean,false),COALESCE((email->>'imported')::boolean,false),observed_at DESC,id DESC
  )${
    includeFiles
      ? Prisma.sql`, files AS (
    SELECT role_id,dedupe_key,jsonb_agg(file) AS attachments FROM (
      SELECT DISTINCT ON (alias.role_id,alias.dedupe_key,file->>'id') alias.role_id,alias.dedupe_key,file
      FROM origins alias CROSS JOIN LATERAL jsonb_array_elements(COALESCE(alias.email->'attachments','[]'::jsonb)) file
      ORDER BY alias.role_id,alias.dedupe_key,file->>'id',alias.observed_at DESC
    ) exact_files GROUP BY role_id,dedupe_key
  )`
      : Prisma.empty
  }, canonical AS (
    SELECT chosen.*${includeFiles ? Prisma.sql`, chosen.email || CASE WHEN files.attachments IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('attachments',files.attachments) END AS display_email` : Prisma.empty}
    FROM preferred chosen ${includeFiles ? Prisma.sql`LEFT JOIN files ON files.role_id=chosen.role_id AND files.dedupe_key=chosen.dedupe_key` : Prisma.empty}
  ), mail AS (SELECT *, COALESCE(thread_key,'message:'||id) AS view_key FROM canonical)`;
}
const cursorSchema = {
  parse(value: string) {
    const parsed = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (
      typeof parsed.id !== "string" ||
      !(
        parsed.at === null ||
        (typeof parsed.at === "string" && Number.isFinite(Date.parse(parsed.at)))
      )
    )
      throw new Error("Invalid mail cursor");
    return { id: parsed.id, at: parsed.at as string | null };
  },
};

export async function readGlobalRecruitingInbox(
  prisma: PrismaClient,
  actor: Actor,
  raw: GlobalRecruitingInboxInput,
  authorize?: () => Promise<void>,
): Promise<GlobalRecruitingInboxOutput> {
  const input = GlobalRecruitingInboxInputSchema.parse({
    query: raw.query,
    roleId: raw.roleId,
    sourceId: raw.sourceId,
    unreadOnly: raw.unreadOnly,
    thread: raw.thread,
    cursor: raw.cursor,
    limit: raw.limit,
  });
  const cursor = input.cursor ? cursorSchema.parse(input.cursor) : null;
  return prisma.$transaction(async (tx) => {
    await authorize?.();
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const initialization = await tx.recruitingInboxInitialization.findUnique({
      where: { userId_spaceId: owned(actor) },
    });
    const baseline = { initializedAt: initialization?.initializedAt ?? new Date() };
    const roles = await tx.recruitingRole.findMany({
      where: {
        ...owned(actor),
        archivedAt: null,
        sourceThread: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          OR: [{ groupId: null }, { group: { archivedAt: null } }],
        },
      },
      include: { sourceThread: { select: { groupId: true } } },
      orderBy: { id: "asc" },
    });
    const base = corpus(actor);
    const filter = Prisma.sql`${input.roleId ? Prisma.sql`AND mail.role_id=${input.roleId}` : Prisma.empty}${input.sourceId ? Prisma.sql`AND source_id=${input.sourceId}` : Prisma.empty}`;
    const thread = input.thread;
    const rows = await tx.$queryRaw<
      {
        id: string;
        role_id: string;
        view_key: string;
        email: unknown;
        display_email?: unknown;
        person: unknown;
        message_at: Date | null;
        latest_incoming_at: Date | null;
      }[]
    >(Prisma.sql`${base}, annotated AS (
      SELECT mail.*,
        bool_or(direction='received' OR direction IS NULL) OVER(PARTITION BY role_id,view_key) AS has_incoming,
        ${input.query ? Prisma.sql`bool_or(search_text ILIKE ${safeLike(input.query)}) OVER(PARTITION BY role_id,view_key)` : Prisma.sql`true`} AS matches,
        bool_or(direction IS NULL OR (direction='received' AND (message_at IS NULL OR message_at>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))) OVER(PARTITION BY view_key) AS unknown,
        CASE WHEN bool_or(direction IS NULL OR (direction='received' AND message_at IS NULL)) OVER(PARTITION BY view_key) THEN NULL
          ELSE max(message_at) FILTER(WHERE direction='received') OVER(PARTITION BY view_key) END AS latest_incoming_at
      FROM mail ${thread ? Prisma.sql`WHERE view_key=${thread.key}` : Prisma.empty}
    ), eligible AS (
      SELECT mail.* FROM annotated mail ${input.unreadOnly ? Prisma.sql`LEFT JOIN recruiting_inbox_cursors c ON c.user_id=${actor.userId} AND c.space_id=${actor.spaceId} AND c.thread_key=mail.thread_key` : Prisma.empty}
      WHERE true ${filter}
      ${thread ? Prisma.sql`AND role_id=${thread.roleId}` : Prisma.sql`AND has_incoming`}
      ${input.unreadOnly ? Prisma.sql`AND mail.thread_key IS NOT NULL AND NOT unknown AND latest_incoming_at IS NOT NULL AND (COALESCE(c.unread,false) OR latest_incoming_at>COALESCE(c.last_read_at,${baseline.initializedAt}))` : Prisma.empty}
    ), selected AS (
      ${thread ? Prisma.sql`SELECT * FROM eligible` : Prisma.sql`SELECT DISTINCT ON(role_id,view_key) * FROM eligible WHERE matches ORDER BY role_id,view_key,(direction='received') DESC NULLS LAST,message_at DESC NULLS LAST,id DESC`}
    ) SELECT * FROM selected WHERE true ${cursor ? Prisma.sql`AND (COALESCE(message_at,'-infinity'::timestamp),id)<(COALESCE(${date(cursor.at)},'-infinity'::timestamp),${cursor.id})` : Prisma.empty}
      ORDER BY message_at DESC NULLS LAST,id DESC LIMIT ${input.limit + 1}`);
    const summary = await inboxSummary(tx, actor, baseline.initializedAt);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const people = await Promise.all(
      page.map((row) =>
        savedPerson(
          tx,
          actor,
          row.role_id,
          emailSchema.parse(row.display_email ?? row.email),
          row.person,
        ),
      ),
    );
    await authorize?.();
    return {
      roles: roles.map((role) => ({
        id: role.id,
        title: role.title,
        threadId: role.sourceThreadId,
        groupId: role.sourceThread.groupId,
        stage: role.playbookStage,
      })),
      items: page.map((row, index) => {
        const email = emailSchema.parse(row.display_email ?? row.email);
        return {
          key: row.view_key,
          roleId: row.role_id,
          latestIncomingAt: row.latest_incoming_at?.toISOString() ?? null,
          email: thread
            ? email
            : {
                ...email,
                body: email.body.slice(0, 300),
                snippet: email.snippet || email.body.length > 300,
              },
          person: people[index] ?? null,
        };
      }),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.message_at?.toISOString() ?? null, id: last.id }),
            ).toString("base64url")
          : null,
      ...summary,
    };
  });
}

async function inboxSummary(tx: Tx, actor: Actor, baseline: Date) {
  const progress = await tx.recruitingInboxIndexProgress.findUnique({
    where: { userId_spaceId: owned(actor) },
  });
  const eligible =
    !progress?.importsComplete || !progress?.crmComplete
      ? await tx.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM recruiting_roles r JOIN threads t ON t.id=r."sourceThreadId" WHERE r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId} AND t."activeRecruitingRoleId"=r.id AND NOT EXISTS(SELECT 1 FROM chat_groups g WHERE g.id=t."groupId" AND g."archivedAt" IS NOT NULL)) AS present`
      : [{ present: true }];
  const empty = !eligible[0]?.present;
  const counts = await tx.$queryRaw<
    { unread: bigint; unknown: bigint }[]
  >(Prisma.sql`${corpus(actor, false)}, inbox_threads AS (
      SELECT COALESCE(thread_key,'message:'||id) AS key,thread_key,max(message_at) FILTER (WHERE direction='received') AS incoming,
        bool_or(direction='received' AND message_at IS NULL) OR bool_or(direction IS NULL) AS unknown
      FROM mail GROUP BY COALESCE(thread_key,'message:'||id),thread_key
      HAVING bool_or(direction='received' OR direction IS NULL)
    ) SELECT count(*) FILTER (WHERE t.thread_key IS NOT NULL AND NOT t.unknown AND t.incoming IS NOT NULL AND t.incoming<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND (COALESCE(c.unread,false) OR t.incoming>COALESCE(c.last_read_at,${baseline}))) AS unread,
      count(*) FILTER (WHERE t.thread_key IS NULL OR t.unknown OR t.incoming IS NULL OR t.incoming>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS unknown
      FROM inbox_threads t LEFT JOIN recruiting_inbox_cursors c ON c.user_id=${actor.userId} AND c.space_id=${actor.spaceId} AND c.thread_key=t.thread_key`);

  return {
    unread: {
      count: Number(counts[0]?.unread ?? 0),
      unknownThreads: Number(counts[0]?.unknown ?? 0),
      scope: "indexed_stored_mail" as const,
    },
    coverage: {
      importsComplete: empty || (progress?.importsComplete ?? false),
      crmComplete: empty || (progress?.crmComplete ?? false),
      native: "observed" as const,
      providerComplete: false as const,
      checkedAt: progress?.checkedAt.toISOString() ?? new Date().toISOString(),
    },
  };
}

/** Navigation reads only the canonical counts and concrete last-indexed coverage. */
export async function readGlobalRecruitingInboxSummary(
  prisma: PrismaClient,
  actor: Actor,
  authorize?: () => Promise<void>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await authorize?.();
    const baseline = await tx.recruitingInboxInitialization.findUnique({
      where: { userId_spaceId: owned(actor) },
    });
    const summary = await inboxSummary(tx, actor, baseline?.initializedAt ?? new Date());
    await authorize?.();
    return summary;
  });
}
