import type {
  Actor,
  ListRecruitingContactsInput,
  ListRecruitingContactsOutput,
  RecruitingContact,
  RecruitingContactFilters,
} from "@rakazo/contracts";
import { ListRecruitingContactsInput as ListInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/**
 * Everyone in the account's open roles and its synced CRM, one row per person.
 *
 * A person is matched across roles and the CRM by LinkedIn profile (role candidates use
 * "linkedin:/in/<handle>", CRM contacts "li:linkedin.com/in/<handle>"), else by the CRM's email
 * key, else they stay their own row. Every read is one SQL statement scoped to the actor's
 * user + space through the indexed owner columns; filters, sorting and paging run in the
 * database so a large account never ships its whole pool to the server or the browser.
 */

type Row = {
  person_key: string;
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedin_url: string | null;
  email: string | null;
  status: string;
  roles: RecruitingContact["roles"] | null;
  note_key: string;
  added_at: Date | null;
  last_contacted: Date | null;
  last_replied: Date | null;
  total: bigint | number;
};

const like = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// A CRM contact's account-wide key, matching a role candidate's "linkedin:/in/<handle>".
const CRM_PERSON_KEY = Prisma.sql`CASE
  WHEN cc."identityKey" LIKE 'li:linkedin.com/in/%' THEN 'linkedin:' || substr(cc."identityKey", 16)
  WHEN cc."identityKey" IS NOT NULL THEN cc."identityKey"
  ELSE 'crm:' || cc.id
END`;

type PeopleOptions = {
  /** Only these people (a page's detail read). */
  keys?: readonly string[];
  /** Read outreach dates from campaign leads and stored mail. */
  activity: boolean;
  /** Each role entry, for display. */
  detail: boolean;
  skills: boolean;
};

/**
 * The account's people as CTEs ending in "people". The page read asks for the cheap columns of
 * everyone it must sort and filter; the detail read then fills in only that page's people.
 */
function peopleSql(actor: Actor, options: PeopleOptions) {
  const user = actor.userId;
  const space = actor.spaceId;
  const { keys, activity, detail, skills } = options;
  const only = (column: Prisma.Sql) =>
    keys ? Prisma.sql`AND ${column} IN (${Prisma.join(keys)})` : Prisma.empty;
  const crmOwner = Prisma.sql`cc."userId" = ${user} AND cc."spaceId" = ${space} AND cc."archivedAt" IS NULL`;
  const crmCandidates = keys
    ? Prisma.sql`AND "crmCandidateId" IN (
        SELECT cc."crmCandidateId" FROM recruiting_crm_contacts cc
        WHERE ${crmOwner} ${only(CRM_PERSON_KEY)})`
    : Prisma.empty;
  return Prisma.sql`
    roles AS (
      SELECT r.id, r.title, t."groupId" AS group_id, r."sourceThreadId" AS thread_id
      FROM recruiting_roles r
      JOIN threads t ON t.id = r."sourceThreadId"
      WHERE r."userId" = ${user} AND r."spaceId" = ${space} AND r."archivedAt" IS NULL
        -- A role whose chat was archived leaves the all-roles lists with it.
        AND NOT EXISTS (
          SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."archivedAt" IS NOT NULL)
    ),
    -- Each role candidate's latest named row and the first time any saved page showed them.
    occ AS (
      SELECT DISTINCT ON (o."roleId", o."candidateKey")
        o."roleId", o."candidateKey", o.name, o.title, o.company, o.location, o."linkedinUrl",
        min(p."observedAt") OVER (PARTITION BY o."roleId", o."candidateKey") AS first_seen
      FROM recruiting_candidate_occurrences o
      JOIN recruiting_candidate_pages p ON p."effectId" = o."pageId"
      WHERE o."roleId" IN (SELECT id FROM roles) ${only(Prisma.sql`o."candidateKey"`)}
      ORDER BY o."roleId", o."candidateKey", (o.name IS NULL), p."observedAt" DESC, o."rowIndex"
    ),
    product AS (
      SELECT
        c."candidateKey" AS person_key,
        occ.name, occ.title, occ.company, occ.location, occ."linkedinUrl" AS linkedin_url,
        NULL::text AS email,
        CASE
          WHEN c.shortlisted THEN 'shortlisted'
          WHEN c.consideration->>'operation' = 'pass' THEN 'passed'
          WHEN c.consideration->>'operation' = 'hold' THEN 'on_hold'
          ELSE 'saved'
        END AS status,
        0 AS source_rank,
        r.id AS role_id, r.title AS role_title, r.group_id,
        c."candidateKey" AS role_candidate_key,
        r.thread_id, c.revision,
        'autumn:' || c."candidateKey" AS note_key,
        c.shortlisted,
        occ.first_seen AS added_at,
        NULL::timestamp AS last_contacted,
        NULL::timestamp AS last_replied,
        NULL::text AS skills
      FROM recruiting_candidates c
      JOIN roles r ON r.id = c."roleId"
      LEFT JOIN occ ON occ."roleId" = c."roleId" AND occ."candidateKey" = c."candidateKey"
      WHERE true ${only(Prisma.sql`c."candidateKey"`)}
    ),
    crm_links AS (
      SELECT rc."contactId" AS contact_id,
        COALESCE(ar.id, 'crm:' || cr.id) AS role_id,
        COALESCE(ar.title, cr."roleLabel") AS role_title,
        ar.group_id
      FROM recruiting_crm_roles cr
      JOIN recruiting_crm_role_contacts rc ON rc."roleId" = cr.id AND rc."archivedAt" IS NULL
      LEFT JOIN recruiting_crm_workspace_attachments a
        ON a."userId" = ${user} AND a."spaceId" = ${space}
        AND a."mcpServerId" = cr."mcpServerId" AND a."organizationId" = cr."organizationId"
        AND a."crmRoleId" = cr."crmRoleId"
      LEFT JOIN roles ar ON ar.id = a."roleId"
      WHERE cr."userId" = ${user} AND cr."spaceId" = ${space} AND cr."archivedAt" IS NULL
    ),
${
  activity
    ? Prisma.sql`    crm_leads AS (
      SELECT l."crmCandidateId" AS candidate_id,
        max(l."lastContactAt") AS contacted, max(l."lastReplyAt") AS replied
      FROM recruiting_crm_leads l
      WHERE l."userId" = ${user} AND l."spaceId" = ${space} AND l."archivedAt" IS NULL
        AND l."crmCandidateId" IS NOT NULL ${crmCandidates}
      GROUP BY 1
    ),
    crm_mail AS (
      SELECT m."crmCandidateId" AS candidate_id,
        max(m."sentAt") FILTER (WHERE m.direction = 'sent') AS contacted,
        max(m."sentAt") FILTER (WHERE m.direction = 'received') AS replied
      FROM recruiting_crm_messages m
      WHERE m."userId" = ${user} AND m."spaceId" = ${space} ${crmCandidates}
      GROUP BY 1
    ),
`
    : Prisma.empty
}    crm AS (
      SELECT
        ${CRM_PERSON_KEY} AS person_key,
        cc.name, cc.title, cc.company, cc.location, cc."linkedinUrl" AS linkedin_url, cc.email,
        COALESCE(NULLIF(cc.stage, ''), NULLIF(cc."outreachStatus", ''), cc."contactStatus") AS status,
        1 AS source_rank,
        cl.role_id, cl.role_title, cl.group_id,
        'crm:' || cc."crmCandidateId" AS role_candidate_key,
        NULL::text AS thread_id, NULL::int AS revision,
        'crm:' || cc."crmCandidateId" AS note_key,
        false AS shortlisted,
        cc."firstSyncedAt" AS added_at,
        ${
          activity
            ? Prisma.sql`GREATEST(ld.contacted, ml.contacted) AS last_contacted,
        GREATEST(cc."lastReplyAt", ld.replied, ml.replied) AS last_replied,`
            : Prisma.sql`NULL::timestamp AS last_contacted, NULL::timestamp AS last_replied,`
        }
        ${skills ? Prisma.sql`(cc.profile->'skills')::text` : Prisma.sql`NULL::text`} AS skills
      FROM recruiting_crm_contacts cc
      LEFT JOIN crm_links cl ON cl.contact_id = cc.id
      ${
        activity
          ? Prisma.sql`LEFT JOIN crm_leads ld ON ld.candidate_id = cc."crmCandidateId"
      LEFT JOIN crm_mail ml ON ml.candidate_id = cc."crmCandidateId"`
          : Prisma.empty
      }
      WHERE ${crmOwner} ${only(CRM_PERSON_KEY)}
    ),
    entries AS (
      SELECT * FROM product
      UNION ALL
      SELECT * FROM crm
    ),
    -- One sort picks each person's display row: a role's own row before the CRM's copy.
    primary_entry AS (
      SELECT DISTINCT ON (person_key) person_key, name, title, company, location, linkedin_url, note_key
      FROM entries
      ORDER BY person_key, source_rank, (name IS NULL), added_at DESC NULLS LAST
    ),
    totals AS (
      SELECT
        person_key,
        max(email) AS email,
        -- The CRM's pipeline stage says more than a saved/shortlisted mark when both exist.
        max(status) FILTER (WHERE source_rank = 1) AS crm_status,
        min(CASE status WHEN 'shortlisted' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'passed' THEN 2 ELSE 3 END)
          FILTER (WHERE source_rank = 0) AS product_status,
        array_agg(role_id) FILTER (WHERE role_id IS NOT NULL) AS role_ids,
        ${
          detail
            ? Prisma.sql`jsonb_agg(jsonb_build_object(
          'id', role_id, 'title', role_title, 'groupId', group_id,
          'candidateKey', role_candidate_key, 'shortlisted', shortlisted,
          'threadId', thread_id, 'revision', revision
        )) FILTER (WHERE role_id IS NOT NULL)`
            : Prisma.sql`NULL::jsonb`
        } AS roles,
        bool_or(shortlisted) AS shortlisted,
        min(added_at) AS added_at,
        max(last_contacted) AS last_contacted,
        max(last_replied) AS last_replied
        ${skills ? Prisma.sql`, string_agg(concat_ws(' ', title, skills), ' ') AS skills` : Prisma.empty}
      FROM entries
      GROUP BY person_key
    ),
    people AS (
      SELECT f.*, t.email, t.role_ids, t.roles, t.shortlisted, t.added_at, t.last_contacted,
        t.last_replied, ${skills ? Prisma.sql`t.skills,` : Prisma.empty}
        COALESCE(t.crm_status,
          CASE t.product_status WHEN 0 THEN 'shortlisted' WHEN 1 THEN 'on_hold' WHEN 2 THEN 'passed' ELSE 'saved' END
        ) AS status
      FROM primary_entry f JOIN totals t USING (person_key)
    )`;
}

function filterSql(actor: Actor, filters: RecruitingContactFilters) {
  const where: Prisma.Sql[] = [];
  const profile = (condition: Prisma.Sql) => Prisma.sql`EXISTS (
    SELECT 1 FROM recruiting_saved_profiles sp
    WHERE sp."spaceId" = ${actor.spaceId} AND sp."ownerUserId" = ${actor.userId}
      AND sp."personKey" = p.person_key AND ${condition})`;
  if (filters.query) {
    const pattern = like(filters.query);
    where.push(Prisma.sql`(p.name ILIKE ${pattern} OR p.title ILIKE ${pattern}
      OR p.company ILIKE ${pattern} OR p.location ILIKE ${pattern} OR p.email ILIKE ${pattern})`);
  }
  for (const [column, value] of [
    ["location", filters.location],
    ["company", filters.company],
    ["title", filters.title],
  ] as const) {
    if (!value) continue;
    const pattern = like(value);
    if (column === "company")
      where.push(
        Prisma.sql`(p.company ILIKE ${pattern} OR ${profile(
          Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(sp.profile->'experience', '[]'::jsonb)) e
          WHERE e->>'company_name' ILIKE ${pattern} AND (e->>'is_current')::boolean IS DISTINCT FROM false)`,
        )})`,
      );
    else if (column === "title") where.push(Prisma.sql`p.title ILIKE ${pattern}`);
    else where.push(Prisma.sql`p.location ILIKE ${pattern}`);
  }
  if (filters.school) {
    const pattern = like(filters.school);
    where.push(
      profile(Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(sp.profile->'education', '[]'::jsonb)) e
        WHERE e->>'school_name' ILIKE ${pattern})`),
    );
  }
  if (filters.skills) {
    const pattern = like(filters.skills);
    where.push(
      Prisma.sql`(p.skills ILIKE ${pattern} OR ${profile(
        Prisma.sql`(sp.profile->>'headline' ILIKE ${pattern} OR (sp.profile->'experience')::text ILIKE ${pattern})`,
      )})`,
    );
  }
  if (filters.statuses?.length)
    where.push(Prisma.sql`p.status IN (${Prisma.join(filters.statuses)})`);
  if (filters.roleIds?.length)
    where.push(Prisma.sql`p.role_ids && ARRAY[${Prisma.join(filters.roleIds)}]::text[]`);
  if (filters.tags?.length)
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM recruiting_contact_tags tg
      WHERE tg."spaceId" = ${actor.spaceId} AND tg."ownerUserId" = ${actor.userId}
        AND tg."personKey" = p.person_key AND tg.tag IN (${Prisma.join(filters.tags)}))`);
  const range = (column: Prisma.Sql, after?: string, before?: string) => {
    if (after) where.push(Prisma.sql`${column} >= ${new Date(after)}`);
    if (before) where.push(Prisma.sql`${column} < ${new Date(before)}`);
  };
  range(Prisma.sql`p.added_at`, filters.addedAfter, filters.addedBefore);
  range(Prisma.sql`p.last_contacted`, filters.contactedAfter, filters.contactedBefore);
  range(Prisma.sql`p.last_replied`, filters.repliedAfter, filters.repliedBefore);
  if (filters.contacted !== undefined)
    where.push(
      filters.contacted
        ? Prisma.sql`p.last_contacted IS NOT NULL`
        : Prisma.sql`p.last_contacted IS NULL`,
    );
  if (filters.replied !== undefined)
    where.push(
      filters.replied ? Prisma.sql`p.last_replied IS NOT NULL` : Prisma.sql`p.last_replied IS NULL`,
    );
  if (filters.shortlisted !== undefined)
    where.push(Prisma.sql`p.shortlisted = ${filters.shortlisted}`);
  return where.length ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty;
}

/**
 * Name order ignores leading punctuation, digits, symbols and emoji (". Ann", "✨ Ann" sort as
 * "Ann"), and names with no letters at all ("2026-10-12 11:15") go last instead of first.
 */
const JUNK_PREFIX =
  "^[\\s0-9!-/:-@\\[-`{-~\\u00a0-\\u00bf\\u2000-\\u2bff\\u3000-\\u303f\\ufe00-\\ufe0f\\uff01-\\uff0f\\U0001f000-\\U0010ffff]+";
const NAME_KEY = Prisma.sql`lower(regexp_replace(coalesce(p.name, ''), ${JUNK_PREFIX}, ''))`;

const ORDER = {
  name: Prisma.sql`(${NAME_KEY} = '') ASC, ${NAME_KEY} ASC, p.person_key`,
  added: Prisma.sql`p.added_at DESC NULLS LAST, p.person_key`,
  contacted: Prisma.sql`p.last_contacted DESC NULLS LAST, p.person_key`,
  replied: Prisma.sql`p.last_replied DESC NULLS LAST, p.person_key`,
} as const;

/** One entry per role; a product role's own entry wins over its CRM copy. */
function roleList(roles: RecruitingContact["roles"]) {
  const byId = new Map<string, RecruitingContact["roles"][number]>();
  for (const role of roles) {
    const seen = byId.get(role.id);
    if (!seen || (!seen.threadId && role.threadId)) byId.set(role.id, role);
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export async function listRecruitingContacts(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  rawInput: ListRecruitingContactsInput,
): Promise<ListRecruitingContactsOutput> {
  const input = ListInputSchema.parse(rawInput);
  const offset = input.cursor ? Number(input.cursor) : 0;
  const { filters } = input;
  const activity =
    input.sort === "contacted" ||
    input.sort === "replied" ||
    [
      filters.contacted,
      filters.replied,
      filters.contactedAfter,
      filters.contactedBefore,
      filters.repliedAfter,
      filters.repliedBefore,
    ].some((value) => value !== undefined);
  // Which people, in order: only the columns the sort and filters need, for everyone.
  const page = await prisma.$queryRaw<{ person_key: string; total: bigint | number }[]>(Prisma.sql`
    WITH ${peopleSql(actor, { activity, detail: false, skills: Boolean(filters.skills) })}
    SELECT p.person_key, count(*) OVER () AS total
    FROM people p
    ${filterSql(actor, filters)}
    ORDER BY ${ORDER[input.sort]}
    LIMIT ${input.limit} OFFSET ${offset}`);
  const order = page.map((row) => row.person_key);
  // Everything shown for just this page's people.
  const detail = order.length
    ? await prisma.$queryRaw<Row[]>(Prisma.sql`
        WITH ${peopleSql(actor, { keys: order, activity: true, detail: true, skills: false })}
        SELECT p.person_key, p.name, p.title, p.company, p.location, p.linkedin_url, p.email,
          p.status, p.roles, p.note_key, p.added_at, p.last_contacted, p.last_replied, 0 AS total
        FROM people p`)
    : [];
  const byKey = new Map(detail.map((row) => [row.person_key, row]));
  const rows = order.flatMap((key) => byKey.get(key) ?? []);
  const keys = rows.map((row) => row.person_key);
  // Only the page's people: their tags and school, each by its owner-scoped index.
  const [tags, profiles] = keys.length
    ? await Promise.all([
        prisma.$queryRaw<{ person_key: string; tags: string[] }[]>(Prisma.sql`
          SELECT "personKey" AS person_key, array_agg(tag ORDER BY tag) AS tags
          FROM recruiting_contact_tags
          WHERE "spaceId" = ${actor.spaceId} AND "ownerUserId" = ${actor.userId}
            AND "personKey" IN (${Prisma.join(keys)})
          GROUP BY 1`),
        prisma.$queryRaw<{ person_key: string; school: string | null }[]>(Prisma.sql`
          SELECT "personKey" AS person_key, profile->'education'->0->>'school_name' AS school
          FROM recruiting_saved_profiles
          WHERE "spaceId" = ${actor.spaceId} AND "ownerUserId" = ${actor.userId}
            AND "personKey" IN (${Prisma.join(keys)})`),
      ])
    : [[], []];
  const tagsByKey = new Map(tags.map((row) => [row.person_key, row.tags]));
  const schoolByKey = new Map(profiles.map((row) => [row.person_key, row.school]));
  const total = page.length ? Number(page[0]!.total) : 0;
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    items: rows.map((row) => ({
      personKey: row.person_key,
      name: row.name,
      title: row.title,
      company: row.company,
      location: row.location,
      school: schoolByKey.get(row.person_key) ?? null,
      linkedinUrl: row.linkedin_url,
      email: row.email,
      status: row.status,
      noteKey: row.note_key,
      roles: roleList(row.roles ?? []),
      tags: tagsByKey.get(row.person_key) ?? [],
      addedAt: iso(row.added_at),
      lastContactedAt: iso(row.last_contacted),
      lastRepliedAt: iso(row.last_replied),
    })),
    total,
    nextCursor: offset + page.length < total ? String(offset + page.length) : null,
  };
}

/** The roles, statuses and tags the account's filter menus can offer. */
export async function recruitingContactFacets(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
) {
  const [roles, statuses, tags] = await Promise.all([
    prisma.$queryRaw<{ id: string; title: string }[]>(Prisma.sql`
      SELECT r.id, r.title FROM recruiting_roles r
      JOIN threads t ON t.id = r."sourceThreadId"
      WHERE r."userId" = ${actor.userId} AND r."spaceId" = ${actor.spaceId} AND r."archivedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."archivedAt" IS NOT NULL)
      UNION ALL
      SELECT 'crm:' || cr.id, cr."roleLabel" FROM recruiting_crm_roles cr
      WHERE cr."userId" = ${actor.userId} AND cr."spaceId" = ${actor.spaceId} AND cr."archivedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM recruiting_crm_workspace_attachments a
          JOIN recruiting_roles r ON r.id = a."roleId" AND r."archivedAt" IS NULL
          WHERE a."userId" = ${actor.userId} AND a."spaceId" = ${actor.spaceId}
            AND a."mcpServerId" = cr."mcpServerId" AND a."organizationId" = cr."organizationId"
            AND a."crmRoleId" = cr."crmRoleId")`),
    prisma.$queryRaw<{ status: string }[]>(Prisma.sql`
      SELECT DISTINCT status FROM (
        SELECT COALESCE(NULLIF(stage, ''), NULLIF("outreachStatus", ''), "contactStatus") AS status
        FROM recruiting_crm_contacts
        WHERE "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId} AND "archivedAt" IS NULL
      ) s WHERE status IS NOT NULL`),
    prisma.$queryRaw<{ tag: string }[]>(Prisma.sql`
      SELECT DISTINCT tag FROM recruiting_contact_tags
      WHERE "spaceId" = ${actor.spaceId} AND "ownerUserId" = ${actor.userId}`),
  ]);
  return {
    roles: roles.sort((a, b) => a.title.localeCompare(b.title)),
    statuses: [
      ...new Set(["shortlisted", "saved", "on_hold", "passed", ...statuses.map((s) => s.status)]),
    ],
    tags: tags.map((row) => row.tag).sort((a, b) => a.localeCompare(b)),
  };
}

/** Adds and removes the recruiter's own labels; only the actor's own rows change. */
export async function updateRecruitingContactTags(
  prisma: PrismaClient,
  actor: Actor,
  input: { personKeys: string[]; add: string[]; remove: string[] },
) {
  const owner = { spaceId: actor.spaceId, ownerUserId: actor.userId };
  await prisma.$transaction([
    ...(input.remove.length
      ? [
          prisma.recruitingContactTag.deleteMany({
            where: { ...owner, personKey: { in: input.personKeys }, tag: { in: input.remove } },
          }),
        ]
      : []),
    ...(input.add.length
      ? [
          prisma.recruitingContactTag.createMany({
            data: input.personKeys.flatMap((personKey) =>
              input.add.map((tag) => ({ ...owner, personKey, tag })),
            ),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);
  return { ok: true as const };
}
