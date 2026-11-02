import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import type { MailReply } from "@rakazo/contracts";
import {
  inboxThreadKey,
  MailReplySchema,
  MessageBlock as MessageBlockSchema,
} from "@rakazo/contracts";
import { type PrismaClient, projectMailReplyCards } from "@rakazo/db";
import addressparser from "nodemailer/lib/addressparser";
import { htmlToPlainText } from "./keyless-http-web.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read the owned child card and its real receipt, not its last progress sentence. */
export async function readMailReplyOutcomeReport(
  prisma: Pick<PrismaClient, "run" | "message" | "externalEffect">,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
) {
  const sourceSelect = {
    id: true,
    seq: true,
    role: true,
    botId: true,
    runId: true,
    threadId: true,
    blocks: true,
  } as const;
  const select = { id: true, botId: true, sourceMessage: { select: sourceSelect } } as const;
  const where = { spaceId: run.spaceId, userId: run.userId, threadId: run.threadId };
  let owner = await prisma.run.findFirst({
    where: { ...where, id: run.id, botId: run.botId },
    select,
  });
  if (!owner || owner.id !== run.id || !owner.sourceMessage) return undefined;
  const source = owner.sourceMessage;
  const parsed = MessageBlockSchema.array().safeParse(source.blocks);
  const report = parsed.success && parsed.data.length === 1 ? parsed.data[0] : undefined;
  if (source.threadId !== run.threadId) return undefined;
  if (report?.kind === "handoff" && report.report) {
    if (
      report.toBotId !== run.botId ||
      source.role !== "bot" ||
      source.botId !== report.fromBotId ||
      !source.runId
    )
      return undefined;
    owner = await prisma.run.findFirst({
      where: { ...where, id: source.runId, botId: report.fromBotId },
      select,
    });
    if (!owner?.sourceMessage || owner.sourceMessage.threadId !== run.threadId) return undefined;
  }
  // The thread/sequence index starts at this exact delegated request, not the whole conversation history.
  const rows = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      thread: { spaceId: run.spaceId, userId: run.userId },
      runId: owner.id,
      botId: owner.botId,
      role: "bot",
      seq: { gt: owner.sourceMessage.seq },
      blocks: { array_contains: [{ kind: "ask" }] },
    },
    orderBy: { seq: "asc" },
    select: { id: true, runId: true, blocks: true },
  });
  const cards = rows.flatMap((row) => {
    const blocks = MessageBlockSchema.array().safeParse(row.blocks);
    return blocks.success ? [{ ...row, runId: row.runId ?? undefined, blocks: blocks.data }] : [];
  });
  const ids = cards.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.kind === "ask" && block.mailReply && block.approvalEffectId
        ? [block.approvalEffectId]
        : [],
    ),
  );
  if (!ids.length) return undefined;
  const effects = await prisma.externalEffect.findMany({
    where: {
      id: { in: ids },
      spaceId: run.spaceId,
      runId: owner.id,
      run: { ...where, botId: owner.botId },
    },
    select: {
      id: true,
      runId: true,
      status: true,
      request: true,
      result: true,
      updatedAt: true,
      run: { select: { status: true } },
    },
  });
  const verified = new Set(effects.map((effect) => effect.id));
  const projected = await projectMailReplyCards(
    prisma,
    { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false },
    cards,
    effects,
  );
  const facts = projected.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.kind === "ask" &&
      block.approvalEffectId &&
      verified.has(block.approvalEffectId) &&
      block.mailReply
        ? [
            {
              effectId: block.approvalEffectId,
              status: block.mailReply.status,
              sentAt: block.mailReply.sentAt,
              error: block.mailReply.error,
            },
          ]
        : [],
    ),
  );
  if (!facts.length) return undefined;
  return {
    facts,
    text: [...new Set(facts.map((fact) => mailReplyOutcomeInstruction(fact)))].join("\n"),
  };
}
export const replyAddresses = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(replyAddresses)
    : typeof value === "string"
      ? addressparser(value).flatMap((entry) => (entry.address ? [entry.address] : []))
      : [];
export function mailReplyFromAnchor(
  route: ConnectorRoute,
  args: Record<string, unknown>,
  original: Record<string, unknown>,
): MailReply {
  if (!route.resourceId || typeof original.id !== "string")
    throw new Error("The original email is unavailable.");
  const body = object(args.body);
  const from =
    typeof args.eaccount === "string"
      ? args.eaccount
      : typeof original.eaccount === "string"
        ? original.eaccount
        : null;
  const to = replyAddresses(args.to ?? original.from_address_email);
  const sourceId = route.resourceId;
  const threadId = typeof original.thread_id === "string" ? original.thread_id : null;
  // The provider workspace is not a CRM organization. Native mail indexes have no CRM org.
  const organizationId = null;
  const indexedMailbox = typeof original.eaccount === "string" ? original.eaccount : null;
  return {
    from: MailReplySchema.shape.from.parse(from),
    to,
    cc: replyAddresses(args.cc_address_email_list),
    bcc: replyAddresses(args.bcc_address_email_list),
    subject:
      typeof args.subject === "string"
        ? args.subject
        : `Re: ${typeof original.subject === "string" ? original.subject.replace(/^(re:\s*)+/iu, "") : ""}`,
    body:
      typeof args.body_text === "string"
        ? args.body_text
        : typeof body?.text === "string"
          ? body.text
          : htmlToPlainText(String(args.body_html ?? body?.html ?? "")),
    inReplyTo: {
      emailId: original.id,
      sourceId,
      threadId,
      subject: typeof original.subject === "string" ? original.subject : null,
      sender: typeof original.from_address_email === "string" ? original.from_address_email : null,
      ...(indexedMailbox && threadId
        ? {
            inboxKey: inboxThreadKey({
              sourceId,
              organizationId,
              mailbox: indexedMailbox,
              threadId,
            }),
          }
        : {}),
    },
    status: "needs_approval",
    sentAt: null,
  };
}

/** Pin Gmail's existing connector session to the exact owned account, including on replay. */
export function gmailReplyRoute(route: ConnectorRoute, context: AdapterContext): ConnectorRoute {
  const accounts =
    context.connectedConnections?.filter(
      (item) =>
        item.connectorId === "composio" &&
        item.externalId.toLowerCase() === "gmail" &&
        (!route.resourceId || item.id === route.resourceId),
    ) ?? [];
  if (accounts.length !== 1 || !accounts[0]?.providerRef)
    throw new Error("Choose one connected sending mailbox before drafting this reply.");
  if (route.resourceRevision !== undefined && route.resourceRevision !== accounts[0].providerRef)
    throw new Error("This sending mailbox changed. Create a new reply draft.");
  return { ...route, resourceId: accounts[0].id, resourceRevision: accounts[0].providerRef };
}

export async function readGmailReplyCard(
  connector: ConnectorProvider,
  route: ConnectorRoute,
  args: Record<string, unknown>,
  context: AdapterContext,
  expected?: MailReply,
): Promise<MailReply> {
  if (
    typeof args.thread_id !== "string" ||
    typeof args.recipient_email !== "string" ||
    !route.resourceId
  )
    throw new Error("Reply requires the original email thread and recipient.");
  const read = async (tool: string, arguments_: Record<string, unknown>) => {
    for await (const event of connector.execute(
      {
        tool,
        route: { ...route, toolName: tool },
        args: arguments_,
        executionId: `${context.operationId}:${tool}`,
      },
      context,
    )) {
      if (event.type === "error") throw new Error("The original email could not be verified.");
      if (event.type === "result") {
        const result = object(event.data);
        if (result?.successful === false || result?.error)
          throw new Error("The original email could not be verified.");
        const payload = object(result?.data) ?? result;
        if (payload?.successful === false || payload?.error)
          throw new Error("The original email could not be verified.");
        return object(payload?.data) ?? payload;
      }
    }
    throw new Error("The original email could not be verified.");
  };
  const userId = args.user_id ?? "me";
  const profile = await read("GMAIL_GET_PROFILE", { user_id: userId });
  const email =
    typeof profile?.emailAddress === "string"
      ? profile.emailAddress.trim().toLowerCase()
      : typeof profile?.email_address === "string"
        ? profile.email_address.trim().toLowerCase()
        : null;
  const thread = await read("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
    thread_id: args.thread_id,
    user_id: userId,
  });
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const anchor = [...messages].reverse().find((value) => {
    const message = object(value);
    return (
      (!expected || (message?.messageId ?? message?.id) === expected.inReplyTo.emailId) &&
      replyAddresses(message?.sender ?? message?.from).includes(String(args.recipient_email))
    );
  });
  const original = object(anchor);
  if (
    !email ||
    !original ||
    !replyAddresses(original.to ?? original.to_address).some(
      (address) => address.trim().toLowerCase() === email,
    )
  )
    throw new Error("The original email does not match this mailbox and recipient.");
  const emailId = original.messageId ?? original.id;
  if (typeof emailId !== "string" || typeof original.subject !== "string")
    throw new Error("The original email is incomplete.");
  if (
    expected &&
    (email !== expected.from ||
      original.subject !== expected.subject ||
      args.recipient_email !== expected.to[0])
  )
    throw new Error("The original email or sending mailbox changed. Create a new reply draft.");
  return {
    from: email,
    to: replyAddresses([
      args.recipient_email,
      ...(Array.isArray(args.extra_recipients) ? args.extra_recipients : []),
    ]),
    cc: replyAddresses(args.cc),
    bcc: replyAddresses(args.bcc),
    subject: original.subject,
    body:
      typeof args.message_body === "string"
        ? args.is_html === true
          ? htmlToPlainText(args.message_body)
          : args.message_body
        : "",
    inReplyTo: {
      emailId,
      sourceId: route.resourceId,
      threadId: args.thread_id,
      subject: original.subject,
      sender: String(original.sender ?? original.from),
    },
    status: "needs_approval",
    sentAt: null,
  };
}

/** The recorded card outcome is business state, not an instruction to repeat the original tool. */
export function mailReplyOutcomeInstruction(
  reply: Pick<MailReply, "status"> & Pick<Partial<MailReply>, "error">,
) {
  if (reply.status === "sent" && reply.error === "formatting_changed")
    return "The already-created reply card has a verified sent receipt, but the sent message has different line or paragraph formatting. It was sent; the card shows the actual sent body. Explain this formatting difference and never resend or recreate it automatically.";
  const outcome = {
    discarded:
      "The reply card was created and the user explicitly discarded it. Nothing was sent from this card. Stop working on this reply. Do not claim that card creation failed, retry it, or create a replacement card using another tool or route. Only a new explicit recruiter request may restart it.",
    failed:
      "The already-created reply card recorded a definite send failure. It was not a successful send and is not merely an unknown delivery result. Explain the card's safe reason; do not retry automatically.",
    unknown:
      "The already-created reply card has unconfirmed delivery. Do not claim it sent or that nothing was sent. Do not retry; verify the original provider receipt first.",
    sent: "The already-created reply card has a verified sent receipt. Confirm that it was sent and never execute this approved request again.",
    sending:
      "The already-created reply card is still sending. Do not claim delivery or execute this request again.",
    needs_approval:
      "The reply card already exists and awaits the user's Send or Discard choice. Do not send before that decision.",
  };
  return outcome[reply.status];
}
