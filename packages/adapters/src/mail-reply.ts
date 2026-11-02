import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import type { MailReply } from "@rakazo/contracts";
import { inboxThreadKey, MailReplySchema } from "@rakazo/contracts";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "@rakazo/core";
import { JSDOM } from "jsdom";
import addressparser from "nodemailer/lib/addressparser";
import { htmlToPlainText } from "./keyless-http-web.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Derive only the actual rendered body; never substitute approved text for a provider receipt. */
export function nativeReplyBodyWithText<T extends Record<string, unknown>>(
  email: T,
  anchor: Pick<MailReply["inReplyTo"], "emailId" | "threadId">,
): T {
  const body = object(email.body);
  if (
    typeof body?.text === "string" ||
    typeof body?.html !== "string" ||
    email.ue_type !== 3 ||
    typeof email.id !== "string" ||
    email.id === anchor.emailId ||
    !anchor.threadId ||
    email.thread_id !== anchor.threadId
  )
    return email;
  const dom = new JSDOM(body.html);
  try {
    const document = dom.window.document;
    // ponytail: only plain text/paragraph/line-break markup is proven; quotes and richer mail stay unconfirmed.
    if (
      document.body.attributes.length ||
      document.querySelector("script,style") ||
      [...document.body.querySelectorAll("*")].some(
        (node) => !["BR", "P", "DIV"].includes(node.tagName) || node.attributes.length,
      )
    )
      return email;
    return { ...email, body: { ...body, text: htmlToPlainText(document.body.innerHTML) } };
  } finally {
    dom.window.close();
  }
}

/** The same native receipt boundary is used for new sends and saved-card reads. */
export function mailReplyEffectWithText<T extends { request: unknown; result: unknown }>(
  effect: T,
  draft: MailReply,
): T {
  const route =
    boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool")?.route ??
    catalogApprovalDetails(effect.request, "__rakazoCatalogTool")?.route;
  const result = object(effect.result);
  const content = object(result?.structuredContent);
  const email = object(content?.result);
  if (
    route?.connectorId !== "mcp" ||
    route.toolName !== "native_instantly_reply_to_email" ||
    content?.source !== "local_native_instantly_rest" ||
    !email
  )
    return effect;
  return {
    ...effect,
    result: {
      ...result,
      structuredContent: { ...content, result: nativeReplyBodyWithText(email, draft.inReplyTo) },
    },
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
export function mailReplyOutcomeInstruction(reply: Pick<MailReply, "status">) {
  const outcome = {
    discarded:
      "The reply card was created and the user explicitly discarded it. Nothing was sent from this card. Do not claim that card creation failed or retry it.",
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
