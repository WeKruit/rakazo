import addressparser from "nodemailer/lib/addressparser";
import { z } from "zod";

const Nonblank = z.string().refine((value) => value.trim().length > 0);
const Header = Nonblank.refine((value) => !/[\r\n\0]/.test(value));
const EmailAddress = z.email();
const Timestamp = z.iso.datetime({ offset: true });

function canonicalAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return address.slice(0, at + 1) + address.slice(at + 1).toLowerCase();
}

function addresses(value: string | null | undefined): string[] | null {
  if (value && /[\r\n\0]/.test(value)) return null;
  if (!value?.trim()) return [];
  const parsed = addressparser(value);
  if (!parsed.length || parsed.some((entry) => !EmailAddress.safeParse(entry.address).success))
    return null;
  return [...new Set(parsed.map((entry) => canonicalAddress(entry.address!)))].sort();
}

function sameAddresses(
  actual: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const left = addresses(actual);
  const right = addresses(expected);
  return left !== null && right !== null && left.join("\n") === right.join("\n");
}

const AddressList = z.string().refine((value) => addresses(value) !== null);

// The existing MCP reply tool uses flat body fields, not the REST body envelope.
// Explicit recipient validation is required here even though MCP makes it optional.
const ReplyRequest = z
  .strictObject({
    reply_to_uuid: z.uuid(),
    eaccount: EmailAddress,
    to: EmailAddress,
    subject: Header,
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    cc_address_email_list: AddressList.optional(),
    bcc_address_email_list: AddressList.optional(),
    reminder_ts: Timestamp.optional(),
    assigned_to: z.uuid().optional(),
    skip_validation: z.literal(false),
  })
  .refine((request) => !!(request.body_text?.trim() || request.body_html?.trim()));

// Canonical documented API payload only. Native MCP envelope handling belongs to
// the connector; do not guess a .data or .result wrapper or infer fields from text.
const Email = z.strictObject({
  id: z.uuid(),
  timestamp_created: Timestamp,
  timestamp_email: Timestamp,
  message_id: Header,
  subject: z.string(),
  from_address_email: EmailAddress.nullish(),
  to_address_email_list: AddressList,
  cc_address_email_list: AddressList.nullish(),
  bcc_address_email_list: AddressList.nullish(),
  reply_to: z.string().nullish(),
  body: z.strictObject({ text: z.string().optional(), html: z.string().optional() }),
  organization_id: z.uuid(),
  campaign_id: z.uuid().nullish(),
  subsequence_id: z.uuid().nullish(),
  list_id: z.uuid().nullish(),
  lead: z.string().nullish(),
  lead_id: z.uuid().nullish(),
  eaccount: Nonblank,
  ue_type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullish(),
  step: z.string().nullish(),
  is_unread: z.number().nullish(),
  is_auto_reply: z.number().nullish(),
  reminder_ts: Timestamp.nullish(),
  ai_interest_value: z.number().nullish(),
  ai_assisted: z.number().nullish(),
  is_focused: z.number().nullish(),
  i_status: z.number().nullish(),
  thread_id: z.uuid().nullish(),
  content_preview: z.string().nullish(),
  attachment_json: z
    .strictObject({
      files: z.array(
        z.strictObject({
          filename: z.string(),
          size: z.number().optional(),
          type: z.string().optional(),
          url: z.url().optional(),
          error: z.string().nullish(),
        }),
      ),
    })
    .nullish(),
  from_address_json: z.array(z.unknown()).nullish(),
  to_address_json: z.array(z.unknown()).nullish(),
  cc_address_json: z.array(z.unknown()).nullish(),
  ai_agent_id: z.uuid().nullish(),
});

const EmailPage = z.strictObject({
  items: z.array(Email),
  next_starting_after: Nonblank.optional(),
});

export type InstantlyReplyRequest = z.infer<typeof ReplyRequest>;
export type InstantlyEmail = z.infer<typeof Email>;
export type InstantlyEmailPage = z.infer<typeof EmailPage>;
export type InstantlyReplyReceipt = {
  emailId: string;
  messageId: string;
  threadId: string;
  organizationId: string;
  replyToEmailId: string;
  timestampCreated: string;
  timestampEmail: string;
};
export type InstantlyReplyOutcome =
  | { status: "unknown" }
  | { status: "sent_recorded" | "scheduled"; receipt: InstantlyReplyReceipt };

export function readInstantlyReplyRequest(args: unknown): InstantlyReplyRequest | null {
  const parsed = ReplyRequest.safeParse(args);
  return parsed.success ? parsed.data : null;
}

export function readInstantlyEmail(payload: unknown): InstantlyEmail | null {
  const parsed = Email.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function readInstantlyEmailPage(payload: unknown): InstantlyEmailPage | null {
  const parsed = EmailPage.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function instantReplyAnchorMatches(request: unknown, anchorEmail: unknown): boolean {
  const args = readInstantlyReplyRequest(request);
  const anchor = readInstantlyEmail(anchorEmail);
  return !!(
    args &&
    anchor &&
    anchor.ue_type === 2 &&
    anchor.id === args.reply_to_uuid &&
    anchor.thread_id &&
    anchor.from_address_email &&
    sameAddresses(anchor.eaccount, args.eaccount) &&
    addresses(anchor.to_address_email_list)?.includes(canonicalAddress(args.eaccount)) &&
    sameAddresses(anchor.reply_to ?? anchor.from_address_email, args.to)
  );
}

export function classifyInstantlyReplyReceipt(
  request: unknown,
  anchorEmail: unknown,
  payload: unknown,
): InstantlyReplyOutcome {
  const args = readInstantlyReplyRequest(request);
  const anchor = readInstantlyEmail(anchorEmail);
  const email = readInstantlyEmail(payload);
  if (
    !args ||
    !anchor ||
    !email ||
    !instantReplyAnchorMatches(args, anchor) ||
    !email.thread_id ||
    email.id === anchor.id ||
    email.organization_id !== anchor.organization_id ||
    email.thread_id !== anchor.thread_id ||
    !email.from_address_email ||
    !sameAddresses(email.eaccount, args.eaccount) ||
    !sameAddresses(email.from_address_email, args.eaccount) ||
    !sameAddresses(email.to_address_email_list, args.to) ||
    !sameAddresses(email.cc_address_email_list, args.cc_address_email_list) ||
    !sameAddresses(email.bcc_address_email_list, args.bcc_address_email_list) ||
    email.subject !== args.subject ||
    (args.body_text !== undefined && email.body.text !== args.body_text) ||
    (args.body_html !== undefined && email.body.html !== args.body_html) ||
    (email.ue_type !== 3 && email.ue_type !== 4)
  )
    return { status: "unknown" };

  // This proves an API message record, never delivery or ancillary reminder/assignment changes.
  return {
    status: email.ue_type === 3 ? "sent_recorded" : "scheduled",
    receipt: {
      emailId: email.id,
      messageId: email.message_id,
      threadId: email.thread_id,
      organizationId: email.organization_id,
      replyToEmailId: anchor.id,
      timestampCreated: email.timestamp_created,
      timestampEmail: email.timestamp_email,
    },
  };
}
