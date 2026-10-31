import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CompanySiteResolver, OrganizationLogoStore } from "./company-site.js";
import { companyTokens } from "./company-site.js";

function savedAnswer(row: {
  host: string | null;
  icon: string | null;
  checkedAt: Date;
  checkAgainAt: Date;
}) {
  const staleMiss =
    !row.host && !row.icon && row.checkAgainAt.getTime() - row.checkedAt.getTime() > OLD_MISS_MS;
  return {
    host: row.host,
    ...(row.icon ? { icon: row.icon } : {}),
    expiresAt: staleMiss ? 0 : row.checkAgainAt.getTime(),
  };
}

/** Logos kept in the database, shared by every user: organization names only, never a person. */
export function createPrismaOrganizationLogoStore(
  prisma: Pick<PrismaClient, "organizationLogo">,
): OrganizationLogoStore {
  return {
    async get(key) {
      const row = await prisma.organizationLogo.findUnique({ where: { key } });
      return row ? savedAnswer(row) : null;
    },
    async getMany(keys) {
      const rows = await prisma.organizationLogo.findMany({ where: { key: { in: [...keys] } } });
      return new Map(rows.map((row) => [row.key, savedAnswer(row)]));
    },
    async put(key, found, expiresAt) {
      const data = {
        host: found.host,
        icon: found.icon ?? null,
        checkedAt: new Date(),
        checkAgainAt: new Date(expiresAt),
      };
      await prisma.organizationLogo.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    },
  };
}

/**
 * Misses saved while the index search read only three results were kept three days; they may have
 * missed an organization the index has, so they are looked up again. Misses are now kept two days,
 * which tells them apart.
 */
const OLD_MISS_MS = 2.5 * 24 * 60 * 60 * 1000;
const MAX_NAMES = 50_000;
const CLAIM_MS = 15 * 60 * 1000;
/** A claimed name not looked up yet: due at once, so a page asking meanwhile looks it up too. */
const UNCHECKED = new Date(0);

/**
 * Takes a name for this worker; false when another worker is already looking it up. An old miss
 * is taken too, and becomes an unfinished claim until the lookup saves its answer.
 */
async function claim(prisma: Pick<PrismaClient, "organizationLogo" | "$executeRaw">, key: string) {
  const created = await prisma.organizationLogo
    .create({ data: { key, checkAgainAt: UNCHECKED } })
    .then(() => true)
    .catch(() => false);
  if (created) return true;
  const taken = await prisma.$executeRaw`
    UPDATE organization_logos
       SET "checkedAt" = now() AT TIME ZONE 'UTC', "checkAgainAt" = 'epoch'::timestamp
     WHERE key = ${key} AND host IS NULL AND icon IS NULL
       AND (("checkAgainAt" = 'epoch'::timestamp
              AND "checkedAt" < now() AT TIME ZONE 'UTC' - make_interval(secs => ${CLAIM_MS / 1000}))
            OR "checkAgainAt" - "checkedAt" > make_interval(secs => ${OLD_MISS_MS / 1000}))`;
  return taken === 1;
}
const CONCURRENCY = 2;

/**
 * Looks up, once, the logo of every company and school on any saved person of any user that has
 * no saved answer yet, newest roles first, so Results shows logos without a live lookup. Safe to
 * run on every start: names with a saved answer are skipped, and a failure only skips that name.
 */
export async function fillOrganizationLogos(
  prisma: Pick<PrismaClient, "organizationLogo" | "$queryRaw" | "$executeRaw">,
  resolver: CompanySiteResolver,
  options: { signal?: AbortSignal; maxLookups: number },
) {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM (
      SELECT o.company AS name, max(p."observedAt") AS seen
        FROM recruiting_candidate_occurrences o
        JOIN recruiting_candidate_pages p ON p."effectId" = o."pageId"
       WHERE o.company IS NOT NULL AND length(o.company) BETWEEN 1 AND 80
       GROUP BY o.company
      UNION ALL
      SELECT org AS name, max(s."updatedAt") AS seen
        FROM recruiting_saved_profiles s,
             LATERAL (
               SELECT e->>'company_name' AS org FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(s.profile->'experience') = 'array'
                      THEN s.profile->'experience' ELSE '[]'::jsonb END) e
               UNION ALL
               SELECT e->>'school_name' FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(s.profile->'education') = 'array'
                      THEN s.profile->'education' ELSE '[]'::jsonb END) e
             ) orgs
       WHERE org IS NOT NULL AND length(org) BETWEEN 1 AND 80
       GROUP BY org
    ) names
    GROUP BY name
    ORDER BY max(seen) DESC
    LIMIT ${MAX_NAMES}`;
  // Names with a saved answer are done; a claim whose lookup never finished, or an old miss, is
  // tried again.
  const found = await prisma.organizationLogo.findMany({
    where: {
      checkAgainAt: { gt: UNCHECKED },
      OR: [{ host: { not: null } }, { icon: { not: null } }],
    },
    select: { key: true },
  });
  const misses = await prisma.organizationLogo.findMany({
    where: { checkAgainAt: { gt: UNCHECKED }, host: null, icon: null },
    select: { key: true, checkedAt: true, checkAgainAt: true },
  });
  const saved = new Set([
    ...found.map((row) => row.key),
    ...misses
      .filter((row) => row.checkAgainAt.getTime() - row.checkedAt.getTime() <= OLD_MISS_MS)
      .map((row) => row.key),
  ]);
  const queue: string[] = [];
  for (const { name } of rows) {
    const key = companyTokens(name).join(" ");
    if (!key || saved.has(key)) continue;
    saved.add(key);
    queue.push(name);
    if (queue.length >= options.maxLookups) break;
  }
  const total = { names: queue.length, logos: 0, failed: 0 };
  const work = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (options.signal?.aborted) return;
      // Claim the name first so another worker starting at the same time skips it.
      if (!(await claim(prisma, companyTokens(name).join(" ")))) continue;
      const answer = await resolver.companySite(name).catch(() => null);
      if (!answer || answer.retry) total.failed += 1;
      else if (answer.icon || answer.host) total.logos += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  getLogger().info("organization.logos.fill", total);
  return total;
}
