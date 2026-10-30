import type { PrismaClient } from "@rakazo/db";
import { listRecruitingCandidates } from "@rakazo/db";
import { LOOKUP_BATCH } from "./contact-lookup.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import type { SavedContactLookups } from "./recruiting-research.js";

export type RoleContactBatch = {
  people: { name: string; linkedin_url: string; company?: string }[];
  /** People among the first `target` still to look up after this batch. */
  remaining: number;
  /** People among the first `target` some source already looked up. */
  alreadyLookedUp: number;
  /** People among the first `target` with no LinkedIn link, who cannot be looked up. */
  withoutProfile: number;
};

/**
 * The next people to look up among the first `target` of the role's Results, in Results order,
 * skipping anyone a source already looked up. The server pages the list itself, so a long lookup
 * never depends on the agent carrying cursors or choosing the order.
 */
export async function nextRoleContactBatch(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  roleId: string,
  target: number,
  saved: SavedContactLookups,
): Promise<RoleContactBatch> {
  const rows: { name: string | null; linkedinUrl: string | null; company: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRecruitingCandidates(
      prisma,
      { ...actor, email: "", isDeploymentOwner: false },
      {
        roleId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    );
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && rows.length < target);
  const first = rows.slice(0, target);
  const withProfile = first.filter((row) => linkedinPersonKey(row.linkedinUrl ?? ""));
  const pending = withProfile.filter((row) => {
    const key = linkedinPersonKey(row.linkedinUrl ?? "")!;
    return !saved.emails.get(key)?.length && !saved.searched.get(key)?.size;
  });
  const batch = pending.slice(0, LOOKUP_BATCH);
  return {
    people: batch.map((row) => ({
      name: row.name?.trim() || "Unknown",
      linkedin_url: row.linkedinUrl!,
      ...(row.company ? { company: row.company } : {}),
    })),
    remaining: pending.length - batch.length,
    alreadyLookedUp: withProfile.length - pending.length,
    withoutProfile: first.length - withProfile.length,
  };
}
