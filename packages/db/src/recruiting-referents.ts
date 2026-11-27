import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import { candidateIndexQuery } from "./recruiting.js";

export type RoleReferent = { candidateKey: string; name: string | null; linkedinUrl: string | null };

const profileUrl = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "");

/**
 * The saved people of a role that a hand-off refers to, by saved candidateKey or LinkedIn URL.
 * Anything that is neither is returned as unknown, so a hand-off carries only real people.
 */
export async function roleReferents(
  prisma: Pick<PrismaClient, "$queryRaw">,
  roleId: string,
  refs: readonly string[],
): Promise<{ people: RoleReferent[]; unknown: string[] }> {
  const wanted = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (!wanted.length) return { people: [], unknown: [] };
  const urls = wanted.map(profileUrl);
  const rows = await prisma.$queryRaw<RoleReferent[]>(
    Prisma.sql`${candidateIndexQuery(roleId)} SELECT "candidateKey", "name", "linkedinUrl" FROM base WHERE "candidateKey" IN (${Prisma.join(wanted)}) OR lower(regexp_replace(regexp_replace(coalesce("linkedinUrl", ''), '^https?://(www\\.)?', ''), '/+$', '')) IN (${Prisma.join(urls)})`,
  );
  const unknown = wanted.filter(
    (ref) =>
      !rows.some(
        (row) =>
          row.candidateKey === ref || (row.linkedinUrl && profileUrl(row.linkedinUrl) === profileUrl(ref)),
      ),
  );
  return { people: rows, unknown };
}
