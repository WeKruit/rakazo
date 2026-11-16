import type {
  Actor,
  RecruitingAnalyticsInput,
  RecruitingAnalyticsOutput,
  RecruitingAnalyticsPeopleInput,
  RecruitingAnalyticsPeopleOutput,
} from "@rakazo/contracts";
import {
  RecruitingAnalyticsInputSchema,
  RecruitingAnalyticsPeopleInputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

function analyticsScope(actor: Actor, input: RecruitingAnalyticsInput) {
  return Prisma.sql`
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
    ), first_reply AS (
      SELECT m.person, min(m.at) AS at FROM mail m JOIN first_send f ON f.person = m.person
      WHERE m.direction = 'received' AND m.at >= f.at GROUP BY m.person
    ), cohort AS (
      SELECT f.person, f.at, reply.at AS replied_at
      FROM first_send f LEFT JOIN first_reply reply ON reply.person = f.person
      WHERE f.at >= ${new Date(input.since)} AND f.at < ${new Date(input.until)}
    ), trend AS (
      SELECT to_char(at, 'YYYY-MM-DD') AS date,
        count(*)::int AS contacted, count(replied_at)::int AS replied FROM cohort GROUP BY 1
    ), role_first_send AS (
      SELECT role, person, min(at) AS at FROM mail WHERE direction = 'sent' GROUP BY role, person
    ), role_replies AS (
      SELECT DISTINCT f.role, f.person FROM role_first_send f JOIN mail m ON m.role = f.role AND m.person = f.person
      WHERE m.direction = 'received' AND m.at >= f.at
    ), role_counts AS (
      SELECT r.id AS "roleId", r.title, CASE WHEN EXISTS (SELECT 1 FROM mail m WHERE m.role = r.id) THEN count(f.person)::int END AS contacted, CASE WHEN EXISTS (SELECT 1 FROM mail m WHERE m.role = r.id) THEN count(reply.person)::int END AS replied
      FROM scoped_roles r LEFT JOIN role_first_send f ON f.role = r.id
        AND f.at >= ${new Date(input.since)} AND f.at < ${new Date(input.until)}
      LEFT JOIN role_replies reply ON reply.role = f.role AND reply.person = f.person
      GROUP BY r.id, r.title
    )
  `;
}

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
      trend: RecruitingAnalyticsOutput["trend"];
      groups: RecruitingAnalyticsOutput["groups"];
      shortlisted: bigint;
      unknown: bigint;
      contacted: bigint;
      replied: bigint;
      messages: bigint;
    }[]
  >(Prisma.sql`
    ${analyticsScope(actor, input)}
    SELECT (SELECT coalesce(jsonb_agg(r ORDER BY r.title,r.id),'[]'::jsonb) FROM roles r) AS roles,
      (SELECT count(*) FROM shortlist WHERE in_window) AS shortlisted,
      (SELECT count(*) FROM shortlist WHERE unknown AND NOT coalesce(in_window,false)) AS unknown,
      (SELECT count(*) FROM cohort) AS contacted,
      (SELECT count(*) FROM cohort WHERE replied_at IS NOT NULL) AS replied,
      (SELECT coalesce(jsonb_agg(t ORDER BY t.date), '[]'::jsonb) FROM trend t) AS trend,
      (SELECT coalesce(jsonb_agg(g ORDER BY g.title,g."roleId"), '[]'::jsonb) FROM role_counts g) AS groups,
      (SELECT count(*) FROM mail) AS messages
  `);
  return {
    roles: row!.roles,
    trend: row!.trend,
    groups: row!.groups,
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

export type RecruitingActivityRole = {
  roleId: string;
  title: string;
  /** People first saved to the role in the window (by their earliest saved search page). */
  newPeople: number;
  shortlisted: number;
  /** Distinct people emailed / heard from in the window, from the stored CRM mail. */
  emailedPeople: number;
  repliedPeople: number;
  /** "none_stored": no CRM mail is stored for the role, so its email counts are unknown. */
  mail: "stored" | "none_stored";
};

/**
 * What changed on each role in a time window ("what's new since yesterday"), read live from the
 * stored records the Dashboard and Contacts pages use. Roles with nothing new are only counted.
 */
export async function readRecruitingActivity(
  prisma: PrismaClient,
  actor: Actor,
  raw: RecruitingAnalyticsInput,
): Promise<{ roles: RecruitingActivityRole[]; quietRoles: number }> {
  const input = RecruitingAnalyticsInputSchema.parse(raw);
  const since = new Date(input.since);
  const until = new Date(input.until);
  const rows = await prisma.$queryRaw<(RecruitingActivityRole & { quiet: boolean })[]>(Prisma.sql`
    ${analyticsScope(actor, input)}, activity AS (
      SELECT r.id AS "roleId", r.title,
        (SELECT count(*) FROM (
          SELECT o."candidateKey" FROM recruiting_candidate_occurrences o
          JOIN recruiting_candidate_pages p ON p."effectId" = o."pageId"
          WHERE o."roleId" = r.id GROUP BY o."candidateKey"
          HAVING min(p."observedAt") >= ${since} AND min(p."observedAt") < ${until}) n)::int AS "newPeople",
        (SELECT count(*) FROM recruiting_candidates c WHERE c."roleId" = r.id AND c.shortlisted
          AND c."shortlistedAt" >= ${since} AND c."shortlistedAt" < ${until})::int AS shortlisted,
        (SELECT count(DISTINCT m.person) FROM mail m WHERE m.role = r.id AND m.direction = 'sent'
          AND m.at >= ${since} AND m.at < ${until})::int AS "emailedPeople",
        (SELECT count(DISTINCT m.person) FROM mail m WHERE m.role = r.id AND m.direction = 'received'
          AND m.at >= ${since} AND m.at < ${until})::int AS "repliedPeople",
        CASE WHEN EXISTS (SELECT 1 FROM mail m WHERE m.role = r.id) THEN 'stored' ELSE 'none_stored' END AS mail
      FROM scoped_roles r
    )
    SELECT *, ("newPeople" + shortlisted + "emailedPeople" + "repliedPeople") = 0 AS quiet
    FROM activity ORDER BY title, "roleId"
  `);
  return {
    roles: rows.filter((row) => !row.quiet).map(({ quiet: _quiet, ...role }) => role),
    quietRoles: rows.filter((row) => row.quiet).length,
  };
}

/** Same scoped cohorts as the counters; paged identities make the denominator inspectable. */
export async function readRecruitingAnalyticsPeople(
  prisma: PrismaClient,
  actor: Actor,
  raw: RecruitingAnalyticsPeopleInput,
): Promise<RecruitingAnalyticsPeopleOutput> {
  const input = RecruitingAnalyticsPeopleInputSchema.parse(raw);
  const [row] = await prisma.$queryRaw<
    { items: RecruitingAnalyticsPeopleOutput["items"]; total: bigint }[]
  >(Prisma.sql`
    ${analyticsScope(actor, input)}, people AS MATERIALIZED (
      ${
        input.metric === "shortlisted"
          ? Prisma.sql`
        SELECT c."candidateKey" AS person, NULL::timestamp AS contacted_at, NULL::timestamp AS replied_at,
          min(c."shortlistedAt") AS shortlisted_at
        FROM recruiting_candidates c JOIN scoped_roles r ON r.id=c."roleId"
        WHERE c.shortlisted AND c."shortlistedAt" >= ${new Date(input.since)} AND c."shortlistedAt" < ${new Date(input.until)}
        GROUP BY c."candidateKey"`
          : Prisma.sql`
        SELECT person, at AS contacted_at, replied_at, NULL::timestamp AS shortlisted_at FROM cohort
        ${input.metric === "replied" ? Prisma.sql`WHERE replied_at IS NOT NULL` : Prisma.empty}`
      }
    ), page AS (
      SELECT * FROM people ${input.cursor ? Prisma.sql`WHERE person COLLATE "C" > ${input.cursor}` : Prisma.empty}
      ORDER BY person COLLATE "C" LIMIT ${input.limit + 1}
    ), displayed AS (
      SELECT p.person AS key,
        coalesce(contact.name, profile.name) AS name, contact.email, contact."linkedinUrl",
        to_char(p.contacted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "contactedAt",
        to_char(p.replied_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "repliedAt",
        to_char(p.shortlisted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "shortlistedAt",
        coalesce(associations.roles,'[]'::jsonb) AS roles
      FROM page p
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.email, cc."linkedinUrl" FROM recruiting_crm_contacts cc
        WHERE cc."userId"=${actor.userId} AND cc."spaceId"=${actor.spaceId} AND cc."archivedAt" IS NULL
          AND CASE WHEN cc."identityKey" LIKE 'li:linkedin.com/in/%' THEN 'linkedin:' || substr(cc."identityKey",16)
            WHEN cc."identityKey" IS NOT NULL THEN cc."identityKey" ELSE 'crm:' || cc.id END = p.person
        ORDER BY cc.id LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT o.name FROM recruiting_candidate_occurrences o JOIN scoped_roles r ON r.id=o."roleId"
        WHERE o."candidateKey"=p.person AND o.name IS NOT NULL ORDER BY o."pageId" DESC,o."rowIndex" DESC LIMIT 1
      ) profile ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title) ORDER BY r.title,r.id) AS roles
        FROM scoped_roles r WHERE EXISTS (SELECT 1 FROM mail m WHERE m.role=r.id AND m.person=p.person)
          OR EXISTS (SELECT 1 FROM recruiting_candidates c WHERE c."roleId"=r.id AND c."candidateKey"=p.person)
      ) associations ON true
    ) SELECT coalesce((SELECT jsonb_agg(d ORDER BY d.key COLLATE "C") FROM displayed d),'[]'::jsonb) AS items,
      (SELECT count(*) FROM people) AS total
  `);
  const items = row!.items.slice(0, input.limit);
  return {
    items,
    total: Number(row!.total),
    nextCursor: row!.items.length > input.limit ? items.at(-1)!.key : null,
    coverage: "partial",
  };
}
