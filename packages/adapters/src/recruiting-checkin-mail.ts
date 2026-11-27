import { randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import type { RecruitingCorrespondence } from "@rakazo/contracts";
import { RecruitingCorrespondenceSchema } from "@rakazo/contracts";
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
import { instantlyInboxRow } from "./recruiting-live-correspondence.js";
import type { RecruitingRoleReply } from "./recruiting-tools.js";

/**
 * The mail a reply check-in reads besides a role's own mailbox: the one-off campaigns a
 * conversation created outside a role, and the recruiter's own Gmail threads it emailed people
 * from. Each is read with the connector tool the agent uses, by a member it is assigned to.
 */

type Conversation = { id: string; spaceId: string; userId: string };
type InboxRow = RecruitingCorrespondence["emails"][number];
/** Replies to report, and the mail read (sent and received) as rows the account Inbox stores. */
type Reads = { replies: RecruitingRoleReply[]; complete: boolean; rows: InboxRow[] };
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
  const rows: InboxRow[] = [];
  let complete = true;
  const names = await serverNames(
    deps.prisma,
    conversation,
    campaigns.map((campaign) => campaign.serverId),
  );
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
    const name = names.get(serverId);
    for (const email of page.items) {
      if (email.campaign_id !== campaignId) continue;
      if (name) rows.push(instantlyInboxRow({ id: serverId, name }, email, campaignId, false));
      if (email.ue_type === 2 && Date.parse(email.timestamp_email) >= Date.parse(since))
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
  }
  return { replies, complete, rows };
}

/** The names of this user's connections, as the Inbox shows a message's source. */
async function serverNames(
  prisma: PrismaClient,
  conversation: Conversation,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const servers = await prisma.mcpServer.findMany({
    where: {
      id: { in: [...new Set(ids)] },
      userId: conversation.userId,
      spaceId: conversation.spaceId,
    },
    select: { id: true, name: true },
  });
  return new Map(servers.map((server) => [server.id, server.name]));
}

export type GmailSend = {
  serverId: string;
  threadId: string;
  messageId: string;
  to: string;
};

/** A saved tool call's route, arguments and result body, from its record. */
function savedCall(effect: { request: unknown; result: unknown }) {
  const direct = boundDirectApprovalDetails(effect.request, CATALOG_TOOL);
  const catalog = direct ? undefined : catalogApprovalDetails(effect.request, CATALOG_TOOL);
  const route = direct?.route ?? catalog?.route;
  const args = direct?.args ?? record(catalog?.args.arguments);
  if (route?.connectorId !== "mcp" || !args) return undefined;
  const envelope = record(effect.result);
  const body = mcpObject(envelope?.providerResult ?? envelope);
  return { route, args, result: record(body?.result) ?? body };
}
export type SavedCall = NonNullable<ReturnType<typeof savedCall>>;

const sentRecord = (call: SavedCall) =>
  call.route.toolName === "send_message" &&
  call.result?.sent === true &&
  typeof call.result.threadId === "string" &&
  typeof call.result.messageId === "string" &&
  typeof call.result.to === "string"
    ? { threadId: call.result.threadId, messageId: call.result.messageId, to: call.result.to }
    : undefined;

/** Conversations that sent email from a recruiter's own Gmail since `since`, newest first. */
export async function recentGmailSenders(
  prisma: PrismaClient,
  since: Date,
  take: number,
): Promise<string[]> {
  const servers = await prisma.mcpServer.findMany({
    where: { endpoint: GMAIL_MCP_ENDPOINT, enabled: true },
    select: { id: true },
  });
  const gmail = new Set(servers.map((server) => server.id));
  if (!gmail.size) return [];
  // The send's route names the Gmail connection, whichever tool the agent called it through.
  const effects = await prisma.externalEffect.findMany({
    where: {
      kind: { endsWith: "send_message" },
      status: "completed",
      createdAt: { gte: since },
      request: { path: ["0"], equals: CATALOG_TOOL },
    },
    orderBy: { createdAt: "desc" },
    take,
    select: { request: true, result: true, run: { select: { threadId: true } } },
  });
  return [
    ...new Set(
      effects.flatMap((effect) => {
        const call = savedCall(effect);
        return call && gmail.has(call.route.resourceId) && sentRecord(call)
          ? [effect.run.threadId]
          : [];
      }),
    ),
  ];
}

/** The tool calls this conversation's agents made from `since` on, newest first. */
export async function conversationCalls(
  prisma: PrismaClient,
  conversation: Conversation,
  since: Date,
): Promise<SavedCall[]> {
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
  return effects.flatMap((effect) => {
    const call = savedCall(effect);
    return call ? [call] : [];
  });
}

/**
 * The emails the conversation's agents already read by id: an Instantly email or a Gmail message
 * fetched on its own, or every message of a Gmail thread read in full.
 */
export function seenEmailIds(calls: readonly SavedCall[]): Set<string> {
  return new Set(
    calls.flatMap((call) => {
      const tool = call.route.toolName;
      if (tool === "get_email" || tool === "native_instantly_get_email")
        return typeof call.args.id === "string" ? [call.args.id] : [];
      if (tool === "get_message")
        return typeof call.args.messageId === "string" ? [call.args.messageId] : [];
      const messages = tool === "get_thread" ? call.result?.messages : undefined;
      return Array.isArray(messages)
        ? messages.flatMap((message) => {
            const id = record(message)?.id;
            return typeof id === "string" ? [id] : [];
          })
        : [];
    }),
  );
}

/**
 * The names the recruiter gave the people this conversation emailed, by address, from the
 * recipients of its own send calls ("Ada Lin <ada@…>" or a lead's first and last name): a reply
 * is reported under the name on our record, never one the agent guesses.
 */
// The calls that send mail or put a person in a campaign; a draft or any other call names nobody.
const ADDRESSING_TOOLS = new Set([
  "ensure_role_campaign",
  "send_message",
  "send_email",
  "reply_to_email",
  "create_lead",
  "add_leads",
  "add_leads_to_campaign_or_list_bulk",
]);
export function recipientNames(calls: readonly SavedCall[]): Map<string, string> {
  const names = new Map<string, string>();
  const add = (email: unknown, name: unknown) => {
    if (typeof email !== "string" || typeof name !== "string" || !name.trim()) return;
    const key = email.trim().toLowerCase();
    if (!names.has(key)) names.set(key, name.trim());
  };
  // Calls come newest first, so a later correction of a name wins.
  const addressing = (call: SavedCall) =>
    ADDRESSING_TOOLS.has(call.route.toolName.replace(/^native_(?:instantly_)?/, ""));
  for (const call of calls.filter(addressing))
    for (const field of ["recipients", "to", "leads"]) {
      const value = call.args[field];
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === "string")
          for (const parsed of addressparser(item)) add(parsed.address, parsed.name);
        const lead = record(item);
        if (lead)
          add(
            lead.email,
            [lead.first_name ?? lead.firstName, lead.last_name ?? lead.lastName]
              .filter((part) => typeof part === "string" && part.trim())
              .join(" "),
          );
      }
    }
  return names;
}

/** The emails this conversation sent from the recruiter's own Gmail, by their saved receipts. */
export async function gmailSends(
  prisma: PrismaClient,
  conversation: Conversation,
  calls: readonly SavedCall[],
): Promise<GmailSend[]> {
  const sends = calls.flatMap((call): GmailSend[] => {
    const sent = sentRecord(call);
    return sent ? [{ serverId: call.route.resourceId, ...sent }] : [];
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
  const rows: InboxRow[] = [];
  const names = await serverNames(
    deps.prisma,
    conversation,
    sends.map((send) => send.serverId),
  );
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
    // The recruiter's mailbox is the address our own email in this thread was sent from.
    const mailbox = messages
      .map((value) => record(value))
      .find((message) => typeof message?.id === "string" && sent.has(message.id))?.sender;
    const name = names.get(serverId);
    for (const value of messages) {
      const message = record(value);
      const from = address(message?.sender);
      const at = typeof message?.date === "string" ? Date.parse(message.date) : Number.NaN;
      if (typeof message?.id !== "string") continue;
      const ours = sent.has(message.id);
      const theirs = !ours && !!from && recipients.has(from);
      if (!ours && !theirs) continue;
      const body =
        typeof message.plaintextBody === "string"
          ? message.plaintextBody
          : typeof message.snippet === "string"
            ? message.snippet
            : "";
      const row = name
        ? RecruitingCorrespondenceSchema.shape.emails.element.safeParse({
            id: `${serverId}:${message.id}`,
            sourceName: name,
            sourceId: serverId,
            providerMessageId: message.id,
            providerThreadId: threadId,
            ...(address(mailbox) ? { eaccount: address(mailbox) } : {}),
            savedRead: null,
            direction: ours ? "sent" : "received",
            sender: typeof message.sender === "string" ? message.sender : null,
            recipients: Array.isArray(message.toRecipients)
              ? message.toRecipients.filter((to): to is string => typeof to === "string")
              : [],
            subject: typeof message.subject === "string" ? message.subject : "",
            body: body.slice(0, 50_000),
            snippet: typeof message.plaintextBody !== "string" || body.length > 50_000,
            date: Number.isFinite(at) ? new Date(at).toISOString() : null,
            url: null,
          })
        : undefined;
      if (row?.success) rows.push(row.data);
      if (!theirs || !(at >= Date.parse(since))) continue;
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
  return { replies, complete: threads.size <= GMAIL_THREADS, rows };
}
