import { describe, expect, it } from "vitest";
import {
  classifyInstantlyReplyReceipt,
  instantReplyAnchorMatches,
  readInstantlyEmail,
  readInstantlyEmailPage,
  readInstantlyReplyRequest,
} from "./instantly-reply.js";

const incomingId = "11111111-1111-4111-8111-111111111111";
const outgoingId = "22222222-2222-4222-8222-222222222222";
const threadId = "provider:opaque/thread-123";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const request = {
  reply_to_uuid: incomingId,
  eaccount: "recruiter@example.com",
  to: "candidate@example.com",
  subject: "Re: A synthetic role",
  body_text: "Thank you.\nHere are the details. ",
  skip_validation: false,
};
const anchor = {
  id: incomingId,
  timestamp_created: "2026-10-16T12:00:00.000Z",
  timestamp_email: "2026-10-16T11:59:00.000Z",
  message_id: "<incoming@example.com>",
  subject: "A synthetic role",
  from_address_email: "candidate@example.com",
  to_address_email_list: "recruiter@example.com",
  body: { text: "Please send details." },
  organization_id: workspaceId,
  eaccount: "recruiter@example.com",
  ue_type: 2,
  thread_id: threadId,
};
const outgoing = {
  ...anchor,
  id: outgoingId,
  message_id: "<outgoing@example.com>",
  from_address_email: request.eaccount,
  to_address_email_list: request.to,
  subject: request.subject,
  body: { text: request.body_text },
  ue_type: 3,
};

describe("Instantly reply payload contract", () => {
  it("preserves approved argument values and known optional fields", () => {
    const args = {
      ...request,
      body_html: "<p>Thank you.</p>",
      cc_address_email_list: "Second Person <second@example.com>, third@example.com",
      bcc_address_email_list: "audit@example.com",
      reminder_ts: "2026-10-17T12:00:00.000Z",
      assigned_to: outgoingId,
    };
    expect(readInstantlyReplyRequest(args)).toEqual(args);
    expect(readInstantlyReplyRequest(args)).not.toBe(args);
  });

  it("accepts HTML without manufacturing a plain text body", () => {
    const { body_text: _, ...args } = request;
    const html = { ...args, body_html: "<p>Thank you.</p>" };
    expect(readInstantlyReplyRequest(html)).toEqual(html);
  });

  it("preserves an explicitly empty body format when the other format is nonblank", () => {
    const args = { ...request, body_text: "", body_html: "<p>Thank you.</p>" };
    expect(readInstantlyReplyRequest(args)).toEqual(args);
    expect(
      classifyInstantlyReplyReceipt(args, anchor, {
        ...outgoing,
        body: { text: "", html: args.body_html },
      }).status,
    ).toBe("sent_recorded");
  });

  it.each([
    { reply_to_uuid: "not-an-email-id" },
    { eaccount: "Display <recruiter@example.com>" },
    { eaccount: "recruiter@example.com, other@example.com" },
    { to: "candidate@example.com, other@example.com" },
    { to: "candidate@example.com\r\nBcc: other@example.com" },
    { subject: "\t " },
    { subject: "Hello\nBcc: other@example.com" },
    { body_text: "\t " },
    { body_html: 3 },
    { skip_validation: true },
    { skip_validation: undefined },
    { cc_address_email_list: "second@example.com, broken" },
    { cc_address_email_list: ["second@example.com"] },
    { bcc_address_email_list: "audit@example.com\r\nInjected: header" },
    { cc_address_email_list: " \r\n " },
    { bcc_address_email_list: "\n\t" },
    { reminder_ts: "tomorrow" },
    { assigned_to: "user-name" },
    { additional_recipients: ["other@example.com"] },
    { body: { text: "An unsupported REST envelope" } },
  ])("rejects malformed or unapproved argument variant %j", (change) => {
    expect(readInstantlyReplyRequest({ ...request, ...change })).toBeNull();
  });

  it("requires at least one nonblank body and preserves absent optional values", () => {
    const { body_text: _, ...noBody } = request;
    expect(readInstantlyReplyRequest(noBody)).toBeNull();
    expect(readInstantlyReplyRequest({ ...noBody, body_html: "  " })).toBeNull();
    expect(readInstantlyReplyRequest(request)).toEqual(request);
    expect(readInstantlyReplyRequest(request)).not.toHaveProperty("cc_address_email_list");
  });

  it("reads canonical documented Email and cursor page payloads", () => {
    expect(readInstantlyEmail(anchor)).toEqual(anchor);
    expect(readInstantlyEmailPage({ items: [anchor], next_starting_after: incomingId })).toEqual({
      items: [anchor],
      next_starting_after: incomingId,
    });
    expect(readInstantlyEmailPage({ items: [] })).toEqual({ items: [] });
  });

  it.each(["too_large", "unavailable", null] as const)(
    "retains the documented partial-body reason %s without inventing a full body",
    (body_fallback_reason) => {
      const email = { ...anchor, body: { text: "Excerpt" }, body_fallback_reason };
      expect(readInstantlyEmail(email)).toEqual(email);
      expect(readInstantlyEmailPage({ items: [email] })?.items[0]).toEqual(email);
      if (body_fallback_reason)
        expect(
          classifyInstantlyReplyReceipt(request, anchor, { ...outgoing, body_fallback_reason })
            .status,
        ).toBe("unknown");
    },
  );
  it.each(["truncated", false, 1, {}])(
    "rejects an undocumented body fallback reason %j",
    (body_fallback_reason) => {
      expect(readInstantlyEmail({ ...anchor, body_fallback_reason })).toBeNull();
    },
  );

  it.each([threadId, "33333333-3333-4333-8333-333333333333", " opaque thread ID "])(
    "preserves the nonblank provider thread ID %j in emails and pages",
    (thread_id) => {
      const email = { ...anchor, thread_id };
      expect(readInstantlyEmail(email)).toEqual(email);
      expect(readInstantlyEmailPage({ items: [email] })).toEqual({ items: [email] });
    },
  );

  it.each([
    { success: true },
    { id: outgoingId },
    { ...anchor, id: "invalid" },
    { ...anchor, timestamp_email: "yesterday" },
    { ...anchor, message_id: "" },
    { ...anchor, body: "not the documented body object" },
    { ...anchor, body: { text: false } },
    { ...anchor, ue_type: "2" },
    { ...anchor, from_address_email: false },
    ...["", " \t\n ", false, 42, {}, []].map((thread_id) => ({ ...anchor, thread_id })),
    { ...anchor, error: "Sending failed" },
    { data: anchor },
    { result: anchor },
  ])("rejects malformed Email and guessed wrappers %j", (payload) => {
    expect(readInstantlyEmail(payload)).toBeNull();
  });

  it.each([
    [],
    { success: true },
    { items: [anchor], next_starting_after: 5 },
    { items: [anchor], next_starting_after: null },
    { items: [anchor], next_starting_after: "" },
    { items: [{ id: incomingId }] },
    { data: { items: [anchor] } },
  ])("rejects incomplete or malformed list payloads %j", (payload) => {
    expect(readInstantlyEmailPage(payload)).toBeNull();
  });
});

describe("Instantly existing-thread reply proof", () => {
  it("requires an actual inbound anchor for the exact approved recipient and account", () => {
    expect(instantReplyAnchorMatches(request, anchor)).toBe(true);
    expect(
      instantReplyAnchorMatches(
        { ...request, to: "reply-alias@example.com" },
        { ...anchor, reply_to: "reply-alias@example.com" },
      ),
    ).toBe(true);
  });

  it.each([
    { id: outgoingId },
    { ue_type: 3 },
    { ue_type: 4 },
    { ue_type: null },
    { thread_id: null },
    { thread_id: undefined },
    { organization_id: "" },
    { eaccount: "other@example.com" },
    { to_address_email_list: "other@example.com" },
    { from_address_email: "other@example.com" },
    { reply_to: "other@example.com" },
    { from_address_email: null },
  ])("does not authorize dispatch with an ambiguous anchor %j", (change) => {
    expect(instantReplyAnchorMatches(request, { ...anchor, ...change })).toBe(false);
    expect(classifyInstantlyReplyReceipt(request, { ...anchor, ...change }, outgoing)).toEqual({
      status: "unknown",
    });
  });

  it("records a correlated sent entity without claiming delivery", () => {
    expect(classifyInstantlyReplyReceipt(request, anchor, outgoing)).toEqual({
      status: "sent_recorded",
      receipt: {
        emailId: outgoingId,
        messageId: outgoing.message_id,
        threadId,
        organizationId: workspaceId,
        replyToEmailId: incomingId,
        timestampCreated: outgoing.timestamp_created,
        timestampEmail: outgoing.timestamp_email,
      },
    });
  });

  it("keeps a scheduled record distinct from a sent record", () => {
    expect(
      classifyInstantlyReplyReceipt(request, anchor, { ...outgoing, ue_type: 4 }),
    ).toMatchObject({
      status: "scheduled",
      receipt: { emailId: outgoingId },
    });
  });

  it("matches canonical recipient sets without using display names or list order", () => {
    const args = {
      ...request,
      body_html: "<p>Thank you.</p>",
      cc_address_email_list: "First <one@EXAMPLE.com>, two@example.com",
      bcc_address_email_list: "audit@example.com",
    };
    const sent = {
      ...outgoing,
      to_address_email_list: "Candidate <candidate@EXAMPLE.com>",
      cc_address_email_list: "two@example.com, One <one@example.com>",
      bcc_address_email_list: "Audit <audit@example.com>",
      body: { text: request.body_text, html: args.body_html },
    };
    expect(classifyInstantlyReplyReceipt(args, anchor, sent).status).toBe("sent_recorded");
  });

  it("matches HTML-only requests without substituting or requiring plain text", () => {
    const { body_text: _, ...noText } = request;
    const args = { ...noText, body_html: "<p>Exact HTML.</p>" };
    expect(
      classifyInstantlyReplyReceipt(args, anchor, {
        ...outgoing,
        body: { html: args.body_html, text: "Provider text rendition." },
      }).status,
    ).toBe("sent_recorded");
  });

  it.each([
    { id: incomingId },
    { thread_id: outgoingId },
    { thread_id: null },
    { organization_id: outgoingId },
    { eaccount: "other@example.com" },
    { from_address_email: "other@example.com" },
    { from_address_email: null },
    { to_address_email_list: "other@example.com" },
    { to_address_email_list: "candidate@example.com, extra@example.com" },
    { cc_address_email_list: "extra@example.com" },
    { bcc_address_email_list: "extra@example.com" },
    { subject: "Changed subject" },
    { body: { text: request.body_text.trim() } },
    { body: { html: "<p>Same meaning is insufficient.</p>" } },
    { ue_type: 1 },
    { ue_type: 2 },
    { ue_type: null },
    { ue_type: undefined },
    { success: true, id: outgoingId, timestamp_created: undefined },
  ])("does not turn mismatched or partial provider data into sent proof %j", (change) => {
    expect(classifyInstantlyReplyReceipt(request, anchor, { ...outgoing, ...change })).toEqual({
      status: "unknown",
    });
  });

  it("requires every approved body and recipient list to match", () => {
    const args = {
      ...request,
      body_html: "<p>Exact HTML</p>",
      cc_address_email_list: "one@example.com,two@example.com",
    };
    expect(classifyInstantlyReplyReceipt(args, anchor, outgoing).status).toBe("unknown");
    expect(
      classifyInstantlyReplyReceipt(args, anchor, {
        ...outgoing,
        body: { ...outgoing.body, html: "<p>Changed HTML</p>" },
        cc_address_email_list: "one@example.com,two@example.com",
      }).status,
    ).toBe("unknown");
  });

  it("does not mutate frozen request or provider payloads", () => {
    const frozenRequest = Object.freeze({ ...request });
    const frozenAnchor = Object.freeze({ ...anchor, body: Object.freeze({ ...anchor.body }) });
    const frozenResponse = Object.freeze({
      ...outgoing,
      body: Object.freeze({ ...outgoing.body }),
    });
    expect(classifyInstantlyReplyReceipt(frozenRequest, frozenAnchor, frozenResponse).status).toBe(
      "sent_recorded",
    );
    expect(frozenRequest).toEqual(request);
  });
});
