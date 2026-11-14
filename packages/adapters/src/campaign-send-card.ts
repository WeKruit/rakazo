import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  describeCampaignActivation,
  EMPTY_ACTIVATION_DISPLAY,
  type InstantlyActivationDisplay,
  readRoleCampaignBinding,
} from "./instantly-native-writes.js";

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A read-only native tool call on the same connection, returning its structured result. */
export function connectorRead(
  connector: ConnectorProvider,
  route: ConnectorRoute,
  executionId: string,
  context: AdapterContext,
) {
  return async (tool: string, args: Record<string, unknown>) => {
    for await (const event of connector.execute(
      { tool, route: { ...route, toolName: tool }, args, executionId: `${executionId}:${tool}` },
      context,
    )) {
      if (event.type === "result")
        return object(object(object(event.data)?.structuredContent)?.result);
      if (event.type === "error") return undefined;
    }
    return undefined;
  };
}

/**
 * What an activate_campaign call would send right now, read live: the role's campaign (or the one
 * named), its recipients and each one's first email.
 */
export async function describeSend(input: {
  prisma: Pick<PrismaClient, "thread" | "externalEffect">;
  connector: ConnectorProvider;
  context: AdapterContext;
  route: ConnectorRoute & { resourceId: string };
  args: Record<string, unknown>;
  threadId: string;
  spaceId: string;
  executionId: string;
}): Promise<{ campaignId: string | null; display: InstantlyActivationDisplay }> {
  const { args } = input;
  let campaignId = typeof args.campaign_id === "string" ? args.campaign_id : null;
  const current = await input.prisma.thread.findUnique({
    where: { id: input.threadId },
    select: { activeRecruitingRoleId: true },
  });
  const binding = current?.activeRecruitingRoleId
    ? await readRoleCampaignBinding(
        input.prisma,
        input.spaceId,
        input.route.resourceId,
        current.activeRecruitingRoleId,
      )
    : null;
  // The role's own record (lead types, people waiting to be sent) applies only to its campaign.
  const own = binding && (!campaignId || campaignId === binding.campaignId) ? binding : null;
  if (own) campaignId = own.campaignId;
  const eaccount = own?.eaccount ?? null;
  const display = campaignId
    ? await describeCampaignActivation(
        connectorRead(input.connector, input.route, input.executionId, input.context),
        campaignId,
        eaccount,
        own,
        Array.isArray(args.recipients)
          ? args.recipients.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        args.send_now === true,
      )
    : { ...EMPTY_ACTIVATION_DISPLAY, mailbox: eaccount };
  const misaddressed = display.refusal ? undefined : misaddressedEmail(display);
  return { campaignId, display: misaddressed ? { ...display, refusal: misaddressed } : display };
}

/** An email's greeting: the start of its first line, as plain text. */
const greeting = (body: string) =>
  (
    body
      .replace(/<(br|\/p|\/div)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  ).slice(0, 40);

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? "";

const names = (line: string, name: string) =>
  name.length > 1 &&
  new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(
    line,
  );

/**
 * Why no card can be shown when someone's email opens by greeting another person in the same
 * send, such as the email written for Noah going to Ada: a card must show each person their own.
 */
export function misaddressedEmail(display: InstantlyActivationDisplay): string | undefined {
  const people = display.recipients.map((person) => ({
    person,
    first: firstName(person.name),
    opening: greeting((person.firstEmail ?? display.firstEmail)?.body ?? ""),
  }));
  const wrong = people.flatMap(({ person, first, opening }) => {
    if (!first || !opening || names(opening, first)) return [];
    const other = people.find(
      (entry) =>
        entry.first &&
        entry.first.toLowerCase() !== first.toLowerCase() &&
        names(opening, entry.first),
    );
    return other
      ? [`${person.name ?? person.email}'s email greets ${other.first} ("${opening}")`]
      : [];
  });
  return wrong.length
    ? `Nothing was sent and no card was shown: ${wrong.join("; ")}. Save each of them their own email with ensure_role_campaign (an email per person, greeting them by their own name), then call activate_campaign again.`
    : undefined;
}

/** What the recruiter approves on a send card: who gets which first email, and when. */
export const sendCard = (display: InstantlyActivationDisplay, sendNow: boolean) => ({
  sendNow,
  // When each was confirmed before is shown beside the card, not part of what is approved.
  recipients: display.recipients.map(({ alreadyEmailedAt: _shown, ...recipient }) => recipient),
  firstEmail: display.firstEmail ?? null,
});
