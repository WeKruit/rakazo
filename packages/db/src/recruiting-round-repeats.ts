import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { readRecruiterSeen } from "./recruiting-search-quality.js";

/**
 * The people a later calibration round may not show: anyone an earlier round showed or the
 * recruiter turned down (the playbook's "exclude everyone already seen"), read from the one record
 * of what the recruiter has seen. Someone the search saved but no round showed is new to the
 * recruiter and may be shown: the ten are a review size, and saved findings are reused instead of
 * searched for again. Staging 11-15: with everyone saved before the last round refused, the quick
 * searches kept returning those same people and round 2 came back with 2 of 10, then 1.
 * Used by the round record and by the picks shown in chat while the round is being filled, so a
 * list on screen never holds people the round then refuses.
 */
export async function calibrationRoundRepeats(
  client: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  roleId: string,
  keys: readonly string[],
): Promise<{ round: number; repeats: string[] } | null> {
  const seen = await readRecruiterSeen(client, actor, { roleId, candidateKeys: keys });
  if (!seen.latestRound) return null;
  return {
    round: seen.latestRound.round,
    repeats: keys.filter((key) => {
      const person = seen.people.get(key);
      return person?.round !== undefined || person?.verdict === "not_fit";
    }),
  };
}
