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
    ON CONFLICT (id) DO UPDATE SET dedupe_key=CASE WHEN EXCLUDED.source_kind='observed' AND (EXCLUDED.email->>'eaccount') IS NULL THEN recruiting_inbox_messages.dedupe_key ELSE EXCLUDED.dedupe_key END,thread_key=CASE WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.thread_key,recruiting_inbox_messages.thread_key) ELSE EXCLUDED.thread_key END,source_id=EXCLUDED.source_id,observed_at=EXCLUDED.observed_at,message_at=CASE WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.message_at,recruiting_inbox_messages.message_at) ELSE EXCLUDED.message_at END,direction=CASE WHEN EXCLUDED.source_kind='observed' THEN COALESCE(EXCLUDED.direction,recruiting_inbox_messages.direction) ELSE EXCLUDED.direction END,search_text=CASE WHEN EXCLUDED.source_kind='observed' AND COALESCE((EXCLUDED.email->>'snippet')::boolean,false) AND NOT COALESCE((recruiting_inbox_messages.email->>'snippet')::boolean,false) THEN recruiting_inbox_messages.search_text ELSE EXCLUDED.search_text END,email=(CASE WHEN EXCLUDED.source_kind='observed' AND COALESCE((EXCLUDED.email->>'snippet')::boolean,false) AND NOT COALESCE((recruiting_inbox_messages.email->>'snippet')::boolean,false)
      THEN recruiting_inbox_messages.email || EXCLUDED.email || jsonb_build_object('body',recruiting_inbox_messages.email->'body','snippet',false,'date',COALESCE(NULLIF(EXCLUDED.email->'date','null'::jsonb),recruiting_inbox_messages.email->'date'),'direction',COALESCE(NULLIF(EXCLUDED.email->'direction','null'::jsonb),recruiting_inbox_messages.email->'direction')) ELSE EXCLUDED.email END)
      || CASE WHEN EXCLUDED.source_kind='observed' AND (recruiting_inbox_messages.email ? 'attachments' OR EXCLUDED.email ? 'attachments') THEN jsonb_build_object('attachments', (SELECT COALESCE(jsonb_agg(file),'[]'::jsonb) FROM (SELECT DISTINCT ON (file->>'id') file FROM jsonb_array_elements(COALESCE(recruiting_inbox_messages.email->'attachments','[]'::jsonb)||COALESCE(EXCLUDED.email->'attachments','[]'::jsonb)) file ORDER BY file->>'id') exact_attachments)) ELSE '{}'::jsonb END,
      person=COALESCE(EXCLUDED.person,recruiting_inbox_messages.person)
    WHERE recruiting_inbox_messages.observed_at <= EXCLUDED.observed_at`;
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
    SELECT r.id AS "roleId", e.id AS "receiptId", mail.ordinality AS ordinal, e."createdAt", mail.value AS email, jsonb_build_object('version',e.result->'version','roleId',e.result->'roleId','sourceSha256',e.result->'sourceSha256','importedAt',e.result->'importedAt') AS metadata
    FROM external_effects e JOIN runs run ON run.id=e."runId" JOIN bots b ON b.id=run."botId"
    JOIN recruiting_role_revisions rev ON rev.id=run."initialRecruitingRoleRevisionId"
    JOIN recruiting_roles r ON r.id=rev."roleId" JOIN threads t ON t.id=run."threadId"
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.result->'emails')='array' THEN e.result->'emails' ELSE '[]'::jsonb END) WITH ORDINALITY AS mail
    WHERE e."spaceId"=${actor.spaceId} AND e.kind='recruiting_history_import' AND e.status='completed'
      AND run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND run.trigger='tool_background' AND run.status='completed'
      AND b."userId"=${actor.userId} AND b."spaceId"=${actor.spaceId} AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId}
      AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL AND t."activeRecruitingRoleId"=r.id
      AND e.request->>'roleId'=r.id AND e.result->>'roleId'=r.id
      AND NOT EXISTS (SELECT 1 FROM recruiting_inbox_messages seen WHERE seen.user_id=${actor.userId} AND seen.space_id=${actor.spaceId} AND seen.receipt_id=e.id AND seen.receipt_ordinal=mail.ordinality)
    ORDER BY e."createdAt",e.id,mail.ordinality LIMIT 51`;
  for (const row of imports.slice(0, 50)) {
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
    ORDER BY m."syncedAt",m.id,r.id LIMIT 51`;
  for (const row of mirrors.slice(0, 50))
    await put(tx, actor, {
      roleId: row.roleId,
      organizationId: row.organizationId,
      receiptId: row.id,
      observedAt: row.syncedAt,
      kind: "crm",
      person:
        (await savedPerson(tx, actor, row.roleId, { sourceId: row.sourceId }, null, {
          organizationId: row.organizationId,
          candidateId: row.candidateId,
        })) ?? undefined,
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
  return { importsComplete: imports.length <= 50, crmComplete: mirrors.length <= 50 };
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
  if (existing) return RecruitingRoleCandidateSchema.parse(existing);
  const identity = crmIdentity ?? email.crm;
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
  if (!email.candidateKey) return null;
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
    Prisma.sql`${candidateIndexQuery(roleId, "ranking")} SELECT * FROM base WHERE "candidateKey"=${email.candidateKey} LIMIT 1`,
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
function corpus(actor: Actor) {
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
  ), canonical AS (
    SELECT chosen.id,chosen.user_id,chosen.space_id,chosen.role_id,chosen.origin_key,chosen.dedupe_key,chosen.thread_key,chosen.source_id,chosen.source_kind,chosen.receipt_id,chosen.receipt_ordinal,chosen.observed_at,chosen.message_at,chosen.direction,chosen.search_text,chosen.person,
      chosen.email || CASE WHEN files.attachments IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('attachments',files.attachments) END AS email
    FROM preferred chosen LEFT JOIN LATERAL (
      SELECT jsonb_agg(file) AS attachments FROM (
        SELECT DISTINCT ON (file->>'id') file
        FROM origins alias CROSS JOIN LATERAL jsonb_array_elements(COALESCE(alias.email->'attachments','[]'::jsonb)) file
        WHERE alias.role_id=chosen.role_id AND alias.dedupe_key=chosen.dedupe_key
        ORDER BY file->>'id',alias.observed_at DESC
      ) exact_files
    ) files ON true
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
    const baseline = await tx.recruitingInboxInitialization.upsert({
      where: { userId_spaceId: owned(actor) },
      create: owned(actor),
      update: { userId: actor.userId },
    });
    const coverage = await backfill(tx, actor);
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
    const filter = Prisma.sql`${input.roleId ? Prisma.sql`AND role_id=${input.roleId}` : Prisma.empty}${input.sourceId ? Prisma.sql`AND source_id=${input.sourceId}` : Prisma.empty}`;
    const thread = input.thread;
    const rows = await tx.$queryRaw<
      {
        id: string;
        role_id: string;
        view_key: string;
        email: unknown;
        person: unknown;
        message_at: Date | null;
        latest_incoming_at: Date | null;
      }[]
    >(Prisma.sql`${base}, eligible AS (
      SELECT * FROM mail WHERE true ${filter} ${
        input.unreadOnly
          ? Prisma.sql`AND thread_key IS NOT NULL AND EXISTS (
        SELECT 1 FROM mail received LEFT JOIN recruiting_inbox_cursors c ON c.user_id=${actor.userId} AND c.space_id=${actor.spaceId} AND c.thread_key=received.thread_key
        WHERE received.view_key=mail.view_key AND received.direction='received' AND received.message_at<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND (COALESCE(c.unread,false) OR received.message_at>COALESCE(c.last_read_at,${baseline.initializedAt}))) AND NOT EXISTS (SELECT 1 FROM mail uncertain WHERE uncertain.view_key=mail.view_key AND (uncertain.direction IS NULL OR (uncertain.direction='received' AND (uncertain.message_at IS NULL OR uncertain.message_at>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))))`
          : Prisma.empty
      }
        ${thread ? Prisma.sql`AND role_id=${thread.roleId} AND view_key=${thread.key}` : Prisma.sql`AND EXISTS (SELECT 1 FROM mail incoming WHERE incoming.role_id=mail.role_id AND incoming.view_key=mail.view_key AND (incoming.direction='received' OR incoming.direction IS NULL))`}
    ), matches AS (SELECT DISTINCT role_id,view_key FROM eligible WHERE true ${input.query ? Prisma.sql`AND search_text ILIKE ${safeLike(input.query)}` : Prisma.empty}), selected AS (
      ${thread ? Prisma.sql`SELECT * FROM eligible` : Prisma.sql`SELECT DISTINCT ON (e.role_id,e.view_key) e.* FROM eligible e JOIN matches m ON m.role_id=e.role_id AND m.view_key=e.view_key ORDER BY e.role_id,e.view_key,(e.direction='received') DESC NULLS LAST,e.message_at DESC NULLS LAST,e.id DESC`}
    ) SELECT selected.*, (SELECT CASE WHEN bool_or(incoming.direction='received' AND incoming.message_at IS NULL) THEN NULL ELSE max(incoming.message_at) FILTER (WHERE incoming.direction='received') END FROM mail incoming WHERE incoming.view_key=selected.view_key) AS latest_incoming_at FROM selected WHERE true ${cursor ? Prisma.sql`AND (COALESCE(message_at,'-infinity'::timestamp),id)<(COALESCE(${date(cursor.at)},'-infinity'::timestamp),${cursor.id})` : Prisma.empty}
      ORDER BY message_at DESC NULLS LAST,id DESC LIMIT ${input.limit + 1}`);
    const counts = await tx.$queryRaw<
      { unread: bigint; unknown: bigint }[]
    >(Prisma.sql`${base}, inbox_threads AS (
      SELECT COALESCE(thread_key,'message:'||id) AS key,thread_key,max(message_at) FILTER (WHERE direction='received') AS incoming,
        bool_or(direction='received' AND message_at IS NULL) OR bool_or(direction IS NULL) AS unknown
      FROM mail GROUP BY COALESCE(thread_key,'message:'||id),thread_key
      HAVING bool_or(direction='received' OR direction IS NULL)
    ) SELECT count(*) FILTER (WHERE t.thread_key IS NOT NULL AND NOT t.unknown AND t.incoming IS NOT NULL AND t.incoming<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND (COALESCE(c.unread,false) OR t.incoming>COALESCE(c.last_read_at,${baseline.initializedAt}))) AS unread,
      count(*) FILTER (WHERE t.thread_key IS NULL OR t.unknown OR t.incoming IS NULL OR t.incoming>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS unknown
      FROM inbox_threads t LEFT JOIN recruiting_inbox_cursors c ON c.user_id=${actor.userId} AND c.space_id=${actor.spaceId} AND c.thread_key=t.thread_key`);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const people = await Promise.all(
      page.map((row) =>
        savedPerson(tx, actor, row.role_id, emailSchema.parse(row.email), row.person),
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
        const email = emailSchema.parse(row.email);
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
        coverage.importsComplete && coverage.crmComplete && rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.message_at?.toISOString() ?? null, id: last.id }),
            ).toString("base64url")
          : null,
      unread: {
        count: Number(counts[0]?.unread ?? 0),
        unknownThreads: Number(counts[0]?.unknown ?? 0),
        scope: "indexed_stored_mail",
      },
      coverage: {
        ...coverage,
        native: "observed",
        providerComplete: false,
        checkedAt: new Date().toISOString(),
      },
    };
  });
}
