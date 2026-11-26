import { randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  GMAIL_MCP_ENDPOINT,
} from "@rakazo/core";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import addressparser from "nodemailer/lib/addressparser";
import { readInstantlyEmailPage } from "./instantly-reply.js";
import { htmlToPlainText } from "./keyless-http-web.js";
import type { RecruitingRoleReply } from "./recruiting-tools.js";

/**
 * The mail a reply check-in reads besides a role's own mailbox: the one-off campaigns a
 * conversation created outside a role, and the recruiter's own Gmail threads it emailed people
 * from. Each is read with the connector tool the agent uses, by a member it is assigned to.
 */

type Conversation = { id: string; spaceId: string; userId: string };
type Reads = { replies: RecruitingRoleReply[]; complete: boolean };
const CATALOG_TOOL = "__rakazoCatalogTool";
/** Newest saved tool calls of a conversation looked through for its Gmail sends. */
const SAVED_CALLS = 200;
const GMAIL_THREADS = 20;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

async function readTool(
  deps: { prisma: PrismaClient; connector: Pick<ConnectorProvider, "execute"> },
  conversation: Conversation,
  memberBotIds: readonly string[],
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
  context: AdapterContext,
): Promise<unknown> {
  const assignment = await deps.prisma.botMcpServer.findFirst({
    where: {
      spaceId: conversation.spaceId,
      userId: conversation.userId,
      botId: { in: [...memberBotIds] },
      serverId,
      server: { enabled: true },
    },
    select: { botId: true, server: { select: { revision: true } } },
  });
  if (!assignment) throw new Error("no member reads this mail");
  let result: unknown;
  for await (const event of deps.connector.execute(
    {
      tool,
      route: {
        connectorId: "mcp",
        resourceId: serverId,
        resourceRevision: assignment.server.revision,
        toolName: tool,
      },
      args,
      executionId: randomUUID(),
    },
    { ...context, botId: assignment.botId },
  )) {
    if (event.type === "error") throw new Error("mail read failed");
    if (event.type === "result") result = event.data;
  }
  const structured = record(record(result)?.structuredContent);
  return structured?.result ?? mcpObject(result) ?? structured;
}

/** The campaigns this conversation created to email people outside a role. */
export async function directCampaigns(prisma: PrismaClient, conversation: Conversation) {
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: conversation.spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      request: { path: ["direct"], equals: true },
      run: {
        threadId: conversation.id,
        userId: conversation.userId,
        spaceId: conversation.spaceId,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { request: true, result: true },
  });
  return effects.flatMap((effect) => {
    const serverId = record(effect.request)?.serverId;
    const campaignId = record(effect.result)?.campaignId;
    return typeof serverId === "string" && typeof campaignId === "string"
      ? [{ serverId, campaignId }]
      : [];
  });
}

/** Received emails from `since` on in the one-off campaigns a conversation created. */
export async function directRepliesSince(
  deps: { prisma: PrismaClient; connector: Pick<ConnectorProvider, "execute"> },
  conversation: Conversation,
  memberBotIds: readonly string[],
  campaigns: readonly { serverId: string; campaignId: string }[],
  context: AdapterContext,
  since: string,
): Promise<Reads> {
  const replies: RecruitingRoleReply[] = [];
  let complete = true;
  for (const { serverId, campaignId } of campaigns) {
    const page = readInstantlyEmailPage(
      await readTool(
        deps,
        conversation,
        memberBotIds,
        serverId,
        "list_emails",
        { campaign_id: campaignId, limit: 50 },
        context,
      ),
    );
    if (!page) throw new Error("unreadable mail page");
    complete &&= !page.next_starting_after;
    for (const email of page.items)
      if (
        email.ue_type === 2 &&
        email.campaign_id === campaignId &&
        Date.parse(email.timestamp_email) >= Date.parse(since)
      )
        replies.push({
          id: email.id,
          crmCandidateId: "",
          name: null,
          email: email.from_address_email ?? email.lead ?? null,
          at: email.timestamp_email,
          from: email.from_address_email ?? null,
          subject: email.subject,
          body:
            email.body.text ||
            (email.body.html ? htmlToPlainText(email.body.html) : (email.content_preview ?? "")),
        });
  }
  return { replies, complete };
}

export type GmailSend = {
  serverId: string;
  threadId: string;
  messageId: string;
  to: string;
};

/** Conversations that sent email from a recruiter's own Gmail since `since`, newest first. */
export async function recentGmailSenders(
  prisma: PrismaClient,
  since: Date,
  take: number,
): Promise<string[]> {
  const servers = await prisma.mcpServer.findMany({
    where: { endpoint: GMAIL_MCP_ENDPOINT, enabled: true },
    select: { slug: true },
  });
  const kinds = [...new Set(servers.map((server) => `mcp__${server.slug}__send_message`))];
  if (!kinds.length) return [];
  const effects = await prisma.externalEffect.findMany({
    where: { kind: { in: kinds }, status: "completed", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take,
    select: { run: { select: { threadId: true } } },
  });
  return [...new Set(effects.map((effect) => effect.run.threadId))];
}

/** The emails this conversation sent from the recruiter's own Gmail, by their saved receipts. */
export async function gmailSends(
  prisma: PrismaClient,
  conversation: Conversation,
  since: Date,
): Promise<GmailSend[]> {
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: conversation.spaceId,
      status: "completed",
      updatedAt: { gte: since },
      request: { path: ["0"], equals: CATALOG_TOOL },
      run: {
        threadId: conversation.id,
        userId: conversation.userId,
        spaceId: conversation.spaceId,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: SAVED_CALLS,
    select: { request: true, result: true },
  });
  const sends = effects.flatMap((effect): GmailSend[] => {
    const route =
      boundDirectApprovalDetails(effect.request, CATALOG_TOOL)?.route ??
      catalogApprovalDetails(effect.request, CATALOG_TOOL)?.route;
    if (route?.connectorId !== "mcp" || route.toolName !== "send_message") return [];
    const result = record(effect.result);
    const sent = record(record(result?.providerResult ?? result)?.structuredContent);
    return sent?.sent === true &&
      typeof sent.threadId === "string" &&
      typeof sent.messageId === "string" &&
      typeof sent.to === "string"
      ? [
          {
            serverId: route.resourceId,
            threadId: sent.threadId,
            messageId: sent.messageId,
            to: sent.to,
          },
        ]
      : [];
  });
  if (!sends.length) return [];
  const gmail = await prisma.mcpServer.findMany({
    where: {
      id: { in: [...new Set(sends.map((send) => send.serverId))] },
      userId: conversation.userId,
      spaceId: conversation.spaceId,
      enabled: true,
      endpoint: GMAIL_MCP_ENDPOINT,
    },
    select: { id: true },
  });
  const ids = new Set(gmail.map((server) => server.id));
  return sends.filter((send) => ids.has(send.serverId));
}

const address = (value: unknown) =>
  typeof value === "string" ? addressparser(value)[0]?.address?.trim().toLowerCase() : undefined;

/**
 * Messages from `since` on in the Gmail threads this conversation emailed people from, written by
 * the person each thread's email went to. The id is Gmail's message id, the one the agent reads.
 */
export async function gmailRepliesSince(
  deps: { prisma: PrismaClient; connector: Pick<ConnectorProvider, "execute"> },
  conversation: Conversation,
  memberBotIds: readonly string[],
  sends: readonly GmailSend[],
  context: AdapterContext,
  since: string,
): Promise<Reads> {
  const sent = new Set(sends.map((send) => send.messageId));
  const threads = new Map<string, GmailSend[]>();
  for (const send of sends) {
    const key = `${send.serverId}\n${send.threadId}`;
    threads.set(key, [...(threads.get(key) ?? []), send]);
  }
  const replies: RecruitingRoleReply[] = [];
  for (const group of [...threads.values()].slice(0, GMAIL_THREADS)) {
    const { serverId, threadId } = group[0]!;
    const recipients = new Set(group.map((send) => send.to.trim().toLowerCase()));
    const thread = record(
      await readTool(
        deps,
        conversation,
        memberBotIds,
        serverId,
        "get_thread",
        { threadId, messageFormat: "FULL_CONTENT" },
        context,
      ),
    );
    const messages = thread?.messages;
    if (thread?.id !== threadId || !Array.isArray(messages)) throw new Error("unreadable thread");
    for (const value of messages) {
      const message = record(value);
      const from = address(message?.sender);
      const at = typeof message?.date === "string" ? Date.parse(message.date) : Number.NaN;
      if (
        typeof message?.id !== "string" ||
        sent.has(message.id) ||
        !from ||
        !recipients.has(from) ||
        !(at >= Date.parse(since))
      )
        continue;
      replies.push({
        id: message.id,
        crmCandidateId: "",
        name: null,
        email: from,
        at: new Date(at).toISOString(),
        from,
        subject: typeof message.subject === "string" ? message.subject : null,
        body:
          typeof message.plaintextBody === "string"
            ? message.plaintextBody
            : typeof message.snippet === "string"
              ? message.snippet
              : null,
      });
    }
  }
  return { replies, complete: threads.size <= GMAIL_THREADS };
}
