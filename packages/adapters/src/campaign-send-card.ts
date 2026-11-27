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
  return { campaignId, display };
}

/** What the recruiter approves on a send card: who gets which emails, and when. */
export const sendCard = (display: InstantlyActivationDisplay, sendNow: boolean) => ({
  sendNow,
  // When each was confirmed before is shown beside the card, not part of what is approved.
  recipients: display.recipients.map(({ alreadyEmailedAt: _shown, ...recipient }) => recipient),
  firstEmail: display.firstEmail ?? null,
  // Every later email goes out on the same approval, so it is part of what was approved.
  ...(display.followUps?.length ? { followUps: display.followUps } : {}),
  ...(display.takenOut?.length ? { takenOut: display.takenOut } : {}),
});

/** Where two send cards differ, as paths such as "recipients[1].firstEmail.body" (no values). */
export function changedPaths(shown: unknown, current: unknown, path = "", out: string[] = []) {
  if (out.length >= 10) return out;
  if (!path && shown === undefined) return ["card not recorded"];
  const object = (value: unknown) => value && typeof value === "object";
  if (!object(shown) || !object(current)) {
    if (shown !== current) out.push(path || "card");
    return out;
  }
  const a = shown as Record<string, unknown>;
  const b = current as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const next = Array.isArray(a) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    if (!(key in a) || !(key in b)) out.push(next);
    else changedPaths(a[key], b[key], next, out);
  }
  return out.slice(0, 10);
}
