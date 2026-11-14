import type { Prisma, PrismaClient } from "./client.js";

/**
 * The people a later calibration round may not show: anyone an earlier round showed, or returned
 * before the previous round was recorded (the playbook's "exclude everyone already seen"). One
 * rule for the round record and for the picks shown in chat while the round is being filled, so
 * a list on screen never holds people the round then refuses.
 */
export async function calibrationRoundRepeats(
  client: PrismaClient | Prisma.TransactionClient,
  roleId: string,
  keys: readonly string[],
): Promise<{ round: number; repeats: string[] } | null> {
  const rounds = await client.recruitingCalibrationRound.findMany({
    where: { roleId },
    orderBy: { round: "desc" },
    select: { round: true, createdAt: true, candidateKeys: true },
  });
  const previous = rounds[0];
  if (!previous) return null;
  const shown = new Set(rounds.flatMap((round) => round.candidateKeys));
  const pages = await client.recruitingCandidateOccurrence.findMany({
    where: { roleId, candidateKey: { in: [...keys] } },
    select: { candidateKey: true, page: { select: { observedAt: true } } },
  });
  const earliest = new Map<string, number>();
  for (const row of pages) {
    const at = row.page.observedAt.getTime();
    earliest.set(row.candidateKey, Math.min(earliest.get(row.candidateKey) ?? at, at));
  }
  return {
    round: previous.round,
    repeats: keys.filter(
      (key) => shown.has(key) || (earliest.get(key) ?? 0) <= previous.createdAt.getTime(),
    ),
  };
}
