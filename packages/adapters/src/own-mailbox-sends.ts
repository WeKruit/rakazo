import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { earlierConfirmedSends, projectRecruitingInboxMessages } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { outreachStopRefusal, outreachStops } from "./outreach-stops.js";

/**
 * One-off emails from the recruiter's own mailbox get the same checks as a campaign send, from
 * records: nobody stopped, on hold or passed, and no second first email to someone this account
 * already emailed unless the recruiter asks. Each send leaves its record keyed by the mailbox's own
 * message and thread ids, which role pages and the reply wake read.
 */

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The run's conversation and its role, for this user's run only. */
async function runConversation(
  prisma: Pick<PrismaClient, "run">,
  context: Pick<AdapterContext, "runId" | "spaceId" | "userId">,
) {
  if (!context.runId) return null;
  const run = await prisma.run.findFirst({
    where: { id: context.runId, spaceId: context.spaceId, userId: context.userId },
    select: { thread: { select: { id: true, activeRecruitingRoleId: true } } },
  });
  return run?.thread ?? null;
}

async function runRoleId(
  prisma: Pick<PrismaClient, "run">,
  context: Pick<AdapterContext, "runId" | "spaceId" | "userId">,
) {
  return (await runConversation(prisma, context))?.activeRecruitingRoleId ?? null;
}

/** The record an own-mailbox send leaves on its effect, or undefined for a failed or other one. */
export function ownMailboxSendRecord(result: unknown) {
  const content = object(object(result)?.structuredContent);
  const record = object(content?.result) ?? content;
  return record?.sent === true && typeof record.to === "string"
    ? {
        to: record.to.toLowerCase(),
        messageId: typeof record.messageId === "string" ? record.messageId : null,
        threadId: typeof record.threadId === "string" ? record.threadId : null,
      }
    : undefined;
}

/** When this account last sent a new email to this address from the recruiter's own mailbox. */
async function earlierOwnMailboxSend(
  prisma: Pick<PrismaClient, "externalEffect">,
  context: Pick<AdapterContext, "spaceId" | "userId">,
  to: string,
) {
  const rows = await prisma.externalEffect.findMany({
    where: {
      spaceId: context.spaceId,
      run: { userId: context.userId },
      status: "completed",
      kind: { endsWith: "__send_message" },
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: { result: true, updatedAt: true },
  });
  const sent = rows.find((row) => ownMailboxSendRecord(row.result)?.to === to);
  return sent?.updatedAt.toISOString();
}

/**
 * Why this own-mailbox email must not go out, or undefined. Checked before its card and again
 * before it is sent. A reply in an earlier thread (replyThreadId) is a follow-up, not a repeat.
 */
export async function ownMailboxSendRefusal(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "runId" | "spaceId" | "userId">,
  input: { to: string; replyThreadId?: string | undefined; resend?: boolean | undefined },
): Promise<string | undefined> {
  const to = input.to.trim().toLowerCase();
  const stops = await outreachStops(prisma, context, await runRoleId(prisma, context), [to]);
  if (stops.size) return outreachStopRefusal(stops);
  if (input.replyThreadId || input.resend) return undefined;
  const fromCampaign = (await earlierConfirmedSends(prisma, context.spaceId, "", [to])).get(to);
  const fromMailbox = await earlierOwnMailboxSend(prisma, context, to);
  const at = [fromCampaign, fromMailbox].filter(Boolean).sort().at(-1);
  if (!at) return undefined;
  return `Nothing was sent and no card was shown: this account already emailed ${to} (${at.slice(0, 16).replace("T", " ")} UTC, confirmed by the recruiter). To follow up, send in that thread with replyThreadId. Only if the recruiter asks for a new separate email to them, call again with resend: true. Tell the recruiter in one line.`;
}

/**
 * Puts a sent own-mailbox email on the role's pages when the conversation has a role, and under
 * the conversation in the account Inbox when it has none; the send's own effect stays the receipt.
 * A failure here never turns a sent email into an error.
 */
export async function recordOwnMailboxSend(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "runId" | "spaceId" | "userId">,
  sent: {
    sourceId: string;
    sourceName: string;
    mailbox: string | null;
    to: string;
    subject: string;
    body: string;
    messageId: string;
    threadId: string | null;
    sentAt: string;
  },
) {
  const conversation = await runConversation(prisma, context).catch(() => null);
  if (!conversation) return;
  await projectRecruitingInboxMessages(
    prisma,
    { userId: context.userId, spaceId: context.spaceId, email: "", isDeploymentOwner: false },
    {
      ...(conversation.activeRecruitingRoleId
        ? { roleId: conversation.activeRecruitingRoleId }
        : { conversationId: conversation.id }),
      observedAt: new Date(sent.sentAt),
      emails: [
        {
          id: `${sent.sourceId}:${sent.messageId}`,
          sourceName: sent.sourceName,
          sourceId: sent.sourceId,
          providerMessageId: sent.messageId,
          ...(sent.threadId ? { providerThreadId: sent.threadId } : {}),
          ...(sent.mailbox ? { eaccount: sent.mailbox } : {}),
          savedRead: null,
          direction: "sent",
          sender: sent.mailbox,
          recipients: [sent.to],
          subject: sent.subject,
          body: sent.body,
          snippet: false,
          date: sent.sentAt,
          url: null,
        },
      ],
    },
  ).catch((error: unknown) =>
    getLogger().warn("own_mailbox_send.record_failed", {
      runId: context.runId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
