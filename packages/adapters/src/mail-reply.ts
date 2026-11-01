import type { AdapterContext, ConnectorProvider, ConnectorRoute } from "@rakazo/adapter-kit";
import type { MailReply } from "@rakazo/contracts";
import { inboxThreadKey } from "@rakazo/contracts";
import addressparser from "nodemailer/lib/addressparser";
import { htmlToPlainText } from "./keyless-http-web.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    from,
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
      ? profile.emailAddress
      : typeof profile?.email_address === "string"
        ? profile.email_address
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
  if (!email || !original || !replyAddresses(original.to ?? original.to_address).includes(email))
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
