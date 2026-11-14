import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/** What a campaign has sent and who confirmed it, from the provider's records and our cards. */

/** Emails sent: the provider's total, never fewer than the people it has contacted. */
export function sentCount(total: number | null, contacted: number): number | null {
  return total === null && contacted === 0 ? null : Math.max(total ?? 0, contacted);
}

/**
 * When the recruiter confirmed a send of this campaign on its card: every activate_campaign that
 * completed went through that one-time card, so this is the record of who approved what.
 */
export async function confirmedSends(
  prisma: PrismaClient,
  context: AdapterContext,
  campaignId: string,
) {
  const rows = await prisma.$queryRaw<{ updatedAt: Date }[]>`
    SELECT "updatedAt" FROM external_effects
    WHERE "spaceId" = ${context.spaceId} AND status = 'completed'
      AND kind LIKE '%activate_campaign' AND result::text LIKE ${`%${campaignId}%`}
      AND result::text NOT LIKE '%"error"%' AND result::text NOT LIKE '%already_waiting%'
    ORDER BY "updatedAt" DESC LIMIT 5`;
  return rows.length
    ? {
        recruiterConfirmedSendAt: rows.map((row) => row.updatedAt.toISOString()),
        confirmedNote:
          "The recruiter confirmed these sends on their card at these times (most recent first); nothing in this campaign is emailed without that confirmation. Tell them so if they ask who approved it.",
      }
    : {};
}

/** What the agent is told instead of a card when people were already emailed elsewhere. */
export function repeatedSendRefusal(repeats: Map<string, string>): string {
  const who = [...repeats].map(
    ([email, at]) => `${email} (${at.slice(0, 16).replace("T", " ")} UTC)`,
  );
  return `Nothing was sent and no card was shown: this account already sent a first email to ${who.join(", ")} from another campaign. Tell the recruiter who and when, in one line. Only if they ask to email them again, call activate_campaign again with resend: true; the card then shows when each was emailed.`;
}
