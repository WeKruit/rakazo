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
  return `Nothing was sent and no card was shown: the recruiter already confirmed a first email to ${who.join(", ")} from another campaign. That confirmation means queued or sent, not necessarily sent yet: get_campaign on that campaign says which, so never call it sent from this. Tell the recruiter who was confirmed and when, in one line. Only if they ask to email them again, call activate_campaign again with resend: true; the card then shows when each was confirmed.`;
}

/**
 * People of a send whom another of this account's role campaigns already holds while it is
 * sending or has sent, so they are or were emailed from it; keyed by email, valued by its name.
 * Read from the provider at send time, so two cards confirmed side by side cannot both send.
 */
export async function sendingElsewhere(
  prisma: Pick<PrismaClient, "externalEffect">,
  readCampaign: (campaignId: string) => Promise<Record<string, unknown>>,
  input: { spaceId: string; serverId: string; campaignId: string; emails: string[] },
): Promise<Map<string, string>> {
  const wanted = new Set(input.emails.map((email) => email.trim().toLowerCase()));
  const found = new Map<string, string>();
  if (!wanted.size) return found;
  const bindings = await prisma.externalEffect.findMany({
    where: {
      spaceId: input.spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      request: { path: ["serverId"], equals: input.serverId },
    },
    select: { result: true },
  });
  for (const { result } of bindings) {
    const binding = result as {
      campaignId?: unknown;
      leads?: Record<string, { email?: unknown }>;
    } | null;
    if (typeof binding?.campaignId !== "string" || binding.campaignId === input.campaignId)
      continue;
    const held = Object.values(binding.leads ?? {}).flatMap((lead) =>
      typeof lead?.email === "string" && wanted.has(lead.email.toLowerCase())
        ? [lead.email.toLowerCase()]
        : [],
    );
    if (!held.length) continue;
    const campaign = await readCampaign(binding.campaignId).catch(() => undefined);
    // Active (1) or completed (3): its people are being or have been emailed.
    if (campaign?.status !== 1 && campaign?.status !== 3) continue;
    const name = typeof campaign.name === "string" ? campaign.name : "another campaign";
    for (const email of held) if (!found.has(email)) found.set(email, name);
  }
  return found;
}
