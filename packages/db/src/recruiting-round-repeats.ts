import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { readRecruiterSeen } from "./recruiting-search-quality.js";

/**
 * The people a later calibration round may not show: anyone an earlier round showed, or returned
 * before the previous round was recorded (the playbook's "exclude everyone already seen"), read
 * from the one record of what the recruiter has seen. Used by the round record and by the picks
 * shown in chat while the round is being filled, so a list on screen never holds people the
 * round then refuses.
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
      return person?.round !== undefined || person?.seenBeforeLatestRound;
    }),
  };
}
