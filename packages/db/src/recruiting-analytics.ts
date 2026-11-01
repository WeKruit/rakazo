import type { Actor, RecruitingAnalyticsInput, RecruitingAnalyticsOutput } from "@rakazo/contracts";
import { RecruitingAnalyticsInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/** Stored observations only. A synced mailbox is never proof of complete first-send history. */
export async function readRecruitingAnalytics(
  prisma: PrismaClient,
  actor: Actor,
  raw: RecruitingAnalyticsInput,
): Promise<RecruitingAnalyticsOutput> {
  const input = RecruitingAnalyticsInputSchema.parse(raw);
  const [row] = await prisma.$queryRaw<
    {
      roles: RecruitingAnalyticsOutput["roles"];
      shortlisted: bigint;
      unknown: bigint;
      contacted: bigint;
      replied: bigint;
      messages: bigint;
    }[]
  >(Prisma.sql`
    WITH roles AS (
      SELECT r.id, r.title, t."groupId" AS "groupId"
      FROM recruiting_roles r JOIN threads t ON t.id = r."sourceThreadId"
      WHERE r."userId" = ${actor.userId} AND r."spaceId" = ${actor.spaceId}
        AND r."archivedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."archivedAt" IS NOT NULL)
    ), scoped_roles AS (
      SELECT * FROM roles ${input.roleId ? Prisma.sql`WHERE id = ${input.roleId}` : Prisma.empty}
    ), shortlist AS (
      SELECT c."candidateKey" AS person,
        bool_or(c."shortlistedAt" >= ${new Date(input.since)} AND c."shortlistedAt" < ${new Date(input.until)}) AS in_window,
        bool_or(c."shortlistedAt" IS NULL) AS unknown
      FROM recruiting_candidates c JOIN scoped_roles r ON r.id = c."roleId"
      WHERE c.shortlisted GROUP BY c."candidateKey"
    ), mail AS (
      SELECT a."roleId" AS role,
        CASE WHEN cc."identityKey" LIKE 'li:linkedin.com/in/%' THEN 'linkedin:' || substr(cc."identityKey",16)
          WHEN cc."identityKey" IS NOT NULL THEN cc."identityKey"
          ELSE 'crm:' || cc.id END AS person,
        m.direction, m."sentAt" AS at
      FROM recruiting_crm_messages m
      JOIN recruiting_crm_workspace_attachments a ON a."mcpServerId" = m."mcpServerId"
        AND a."organizationId" = m."organizationId" AND a."crmRoleId" = m."crmRoleId"
        AND a."userId" = ${actor.userId} AND a."spaceId" = ${actor.spaceId}
      JOIN scoped_roles r ON r.id = a."roleId"
      JOIN recruiting_crm_contacts cc ON cc."mcpServerId" = m."mcpServerId"
        AND cc."organizationId" = m."organizationId" AND cc."crmCandidateId" = m."crmCandidateId"
        AND cc."userId" = ${actor.userId} AND cc."spaceId" = ${actor.spaceId} AND cc."archivedAt" IS NULL
      WHERE m."userId" = ${actor.userId} AND m."spaceId" = ${actor.spaceId}
        AND m."sentAt" IS NOT NULL
    ), first_send AS (
      SELECT person, min(at) AS at FROM mail WHERE direction = 'sent' GROUP BY person
    ), cohort AS (
      SELECT f.person, EXISTS (
        SELECT 1 FROM mail m WHERE m.person = f.person AND m.direction = 'received' AND m.at >= f.at
      ) AS replied
      FROM first_send f WHERE f.at >= ${new Date(input.since)} AND f.at < ${new Date(input.until)}
    )
    SELECT (SELECT coalesce(jsonb_agg(r ORDER BY r.title,r.id),'[]'::jsonb) FROM roles r) AS roles,
      (SELECT count(*) FROM shortlist WHERE in_window) AS shortlisted,
      (SELECT count(*) FROM shortlist WHERE unknown AND NOT coalesce(in_window,false)) AS unknown,
      (SELECT count(*) FROM cohort) AS contacted,
      (SELECT count(*) FROM cohort WHERE replied) AS replied,
      (SELECT count(*) FROM mail) AS messages
  `);
  return {
    roles: row!.roles,
    observedShortlistedPeople: Number(row!.shortlisted),
    shortlistDateUnknownPeople: Number(row!.unknown),
    observedContactedPeople: row!.messages > 0 ? Number(row!.contacted) : null,
    observedRepliedPeople: row!.messages > 0 ? Number(row!.replied) : null,
    firstContactedPeople: null,
    replyRate: null,
    coverage: "partial",
    sources: {
      storedCrmMessages: row!.messages > 0 ? "observed" : "unavailable",
      nativeCorrespondence: "not_included",
      importedCorrespondence: "not_included",
      firstSendHistory: "unknown",
      replyClassification: "unknown",
      identityResolution: "partial",
      shortlistHistory: "unknown",
    },
  };
}
