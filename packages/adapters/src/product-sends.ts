import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

// Every email this product sends goes through one of these tools' one-time cards, under any
// connector prefix (instantly__instantly__…, mcp__gmail__…, Composio's GMAIL_…).
const EMAIL_SEND_OPERATIONS = [
  "activate_campaign",
  "add_leads_to_campaign_or_list_bulk",
  "create_lead",
  "reply_to_email",
  "send_email",
  "send_message",
  "GMAIL_SEND_EMAIL",
  "GMAIL_SEND_DRAFT",
  "GMAIL_REPLY_TO_THREAD",
  "GMAIL_FORWARD_MESSAGE",
];

/**
 * How many emails this product has sent for the person, how many send cards wait for them, and
 * how many sends ended in an unknown state. Simulated 11-16 (did-you-really-send, 4/10 twice):
 * "did that email go out?" about someone saved nowhere got "no record can confirm it" on an
 * account that had never sent anything, and Kruit gave way when the recruiter insisted.
 */
export async function productEmailSends(prisma: Pick<PrismaClient, "$queryRaw">, actor: Actor) {
  // One pass over the person's runs in this space (an owner account holds 10,000+).
  const patterns = EMAIL_SEND_OPERATIONS.map((operation) => `%${operation}`);
  const [row] = await prisma.$queryRaw<{ sent: number; waiting: number; unknown: number }[]>`
    SELECT count(*) FILTER (WHERE e.status = 'completed')::int AS sent,
      count(*) FILTER (WHERE e.status = 'intended' AND r.status = 'waiting_input')::int AS waiting,
      count(*) FILTER (WHERE e.status IN ('approved', 'uncertain'))::int AS unknown
    FROM external_effects e JOIN runs r ON r.id = e."runId"
    WHERE e."spaceId" = ${actor.spaceId} AND r."spaceId" = ${actor.spaceId}
      AND r."userId" = ${actor.userId} AND e.kind LIKE ANY(${patterns})`;
  return { sent: row?.sent ?? 0, waitingForCard: row?.waiting ?? 0, unknown: row?.unknown ?? 0 };
}

export type ProductEmailSends = Awaited<ReturnType<typeof productEmailSends>>;

/** What the agent is told about sends when nobody by the asked name is saved. */
export function productSendsNote(sends: ProductEmailSends): string {
  if (!sends.sent && !sends.waitingForCard && !sends.unknown)
    return "Nobody by that name is saved, and this account has never sent an email from here and has no send waiting for confirmation: say plainly that nothing was sent and nothing is waiting to send, and keep that answer when the recruiter insists, since these are the account's complete send records. Mail they sent themselves outside this product is not in them.";
  return "Nobody by that name is saved. sends counts every email this account sent from here (sent), send cards still waiting for confirmation (waitingForCard) and sends whose outcome is unknown (unknown); none of them is known to be to this person.";
}
