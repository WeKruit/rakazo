import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { boundDirectApprovalRequest } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { mailReplyState } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  gmailReplyRoute,
  mailReplyFromAnchor,
  mailReplyOutcomeInstruction,
  readGmailReplyCard,
} from "./mail-reply.js";

const context = {
  userId: "owner",
  spaceId: "space",
  operationId: "operation",
  traceId: "trace",
  signal: new AbortController().signal,
  connectedConnections: [
    {
      id: "connection",
      connectorId: "composio",
      externalId: "gmail",
      displayName: "Gmail",
      providerRef: "account-1",
    },
  ],
} satisfies AdapterContext;
const route = {
  connectorId: "composio",
  resourceId: "connection",
  resourceRevision: "account-1",
  toolName: "GMAIL_REPLY_TO_THREAD",
};
const args = {
  thread_id: "gmail-thread",
  recipient_email: "candidate@example.test",
  message_body: "The supplied draft",
  user_id: "me",
  cc: [],
};
const connector = (email = "mailbox@example.test") =>
  ({
    execute: vi.fn(async function* (call: { tool: string }): AsyncGenerator<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          data:
            call.tool === "GMAIL_GET_PROFILE"
              ? { emailAddress: email }
              : {
                  messages: [
                    {
                      messageId: "original",
                      sender: "Candidate <candidate@example.test>",
                      to: ["mailbox@example.test"],
                      subject: "Original subject",
                    },
                  ],
                },
        },
      };
    }),
  }) as unknown as ConnectorProvider;
describe("mail reply provenance", () => {
  it("pins Gmail to the existing concrete account and rejects changed or ambiguous accounts", () => {
    expect(gmailReplyRoute(route, context)).toEqual(route);
    expect(() => gmailReplyRoute({ ...route, resourceRevision: "old-account" }, context)).toThrow();
    expect(() =>
      gmailReplyRoute(
        { connectorId: "composio", toolName: "GMAIL_REPLY_TO_THREAD" },
        {
          ...context,
          connectedConnections: [
            ...context.connectedConnections,
            { ...context.connectedConnections[0]!, id: "second", providerRef: "account-2" },
          ],
        },
      ),
    ).toThrow();
  });
  it("reads the actual Gmail profile and exact anchor again before dispatch", async () => {
    const draft = await readGmailReplyCard(
      connector(" MAILBOX@EXAMPLE.TEST "),
      route,
      args,
      context,
    );
    expect(draft).toMatchObject({
      from: "mailbox@example.test",
      to: ["candidate@example.test"],
      body: args.message_body,
      inReplyTo: { emailId: "original", sourceId: "connection", threadId: "gmail-thread" },
      status: "needs_approval",
    });
    await expect(
      readGmailReplyCard(connector("changed@example.test"), route, args, context, draft),
    ).rejects.toThrow();
    await expect(
      readGmailReplyCard(connector(), route, args, context, {
        ...draft,
        inReplyTo: { ...draft.inReplyTo, emailId: "another-anchor" },
      }),
    ).rejects.toThrow();
  });
  it("retains actual native mailbox/recipient/body/Cc and derives only the exact Inbox identity", () => {
    const draft = mailReplyFromAnchor(
      { connectorId: "mcp", resourceId: "source", toolName: "native_instantly_reply_to_email" },
      {
        reply_to_uuid: "email",
        eaccount: " sender@EXAMPLE.TEST ",
        body: { text: "Full draft" },
        cc_address_email_list: "copy@example.test",
      },
      {
        id: "email",
        eaccount: "sender@example.test",
        from_address_email: "candidate@example.test",
        subject: "Original",
        organization_id: "20000000-0000-4000-8000-000000000001",
        thread_id: "provider-thread",
      },
    );
    expect(draft).toMatchObject({
      from: "sender@example.test",
      to: ["candidate@example.test"],
      cc: ["copy@example.test"],
      body: "Full draft",
      inReplyTo: {
        emailId: "email",
        inboxKey: JSON.stringify(["source", null, "sender@example.test", "provider-thread"]),
      },
    });
  });
});

it("reports the recorded card outcome rather than inventing missing or unconfirmed cards", () => {
  expect(mailReplyOutcomeInstruction({ status: "discarded" })).toContain("reply card was created");
  expect(mailReplyOutcomeInstruction({ status: "failed" })).toContain("definite send failure");
  expect(mailReplyOutcomeInstruction({ status: "unknown" })).toContain(
    "Do not claim it sent or that nothing was sent",
  );
});

import { mailReplyEffectWithText, nativeReplyBodyWithText } from "./mail-reply.js";

it("verifies the native REST text-only HTML body without matching titles, quoted text, or different recipients", () => {
  const draft = mailReplyFromAnchor(
    { connectorId: "mcp", resourceId: "source", toolName: "native_instantly_reply_to_email" },
    { eaccount: "sender@example.test", body: { text: "Draft" }, subject: "Re: Original" },
    {
      id: "anchor",
      thread_id: "thread",
      eaccount: "sender@example.test",
      from_address_email: "candidate@example.test",
      subject: "Original",
    },
  );
  const html = (body: string, title = "Original") =>
    `<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const reply = { ...draft, body: "谢谢，A & B < C > D.\nNext line." };
  const escaped = "谢谢，A &amp; B &lt; C &gt; D.  Next line.";
  const request = boundDirectApprovalRequest(
    { connectorId: "mcp", resourceId: "source", toolName: "native_instantly_reply_to_email" },
    {
      reply_to_uuid: reply.inReplyTo.emailId,
      eaccount: reply.from,
      subject: reply.subject,
      body: { text: reply.body },
    },
    "__rakazoCatalogTool",
  );
  const receipt = {
    id: "new-email",
    ue_type: 3,
    eaccount: reply.from,
    subject: reply.subject,
    to_address_email_list: reply.to.join(","),
    cc_address_email_list: "",
    thread_id: reply.inReplyTo.threadId,
    body: { html: html(escaped) },
  };
  const effect = (payload: Prisma.JsonObject) =>
    mailReplyEffectWithText(
      {
        status: "completed",
        request: request as Prisma.JsonArray,
        result: { structuredContent: { source: "local_native_instantly_rest", result: payload } },
        updatedAt: new Date("2026-11-02T02:36:20Z"),
      },
      reply,
    );
  expect(mailReplyState(reply, effect(receipt))).toMatchObject({
    status: "sent",
    sentAt: "2026-11-02T02:36:20.000Z",
  });
  for (const changed of [
    { body: { html: html("Different reply", escaped) } },
    { body: { html: html(`<blockquote>${escaped}</blockquote>`) } },
    { body: { html: html(`<div class="gmail_quote">${escaped}</div>`) } },
    { body: { html: html(`<script>${escaped}</script>`) } },
    { body: { html: html(`<span>${escaped}</span>`) } },
    { body: { html: html(`Different reply ${escaped}`) } },
    { body: { html: html(`${escaped} Extra unapproved sentence.`) } },
    { to_address_email_list: "someone-else@example.test" },
    { id: reply.inReplyTo.emailId },
    { thread_id: "different-thread" },
    { body: { html: html(escaped), text: "Different plain text" } },
    { ue_type: 4 },
  ])
    expect(mailReplyState(reply, effect({ ...receipt, ...changed }))).toMatchObject({
      status: "unknown",
      sentAt: null,
    });
  for (const markup of [
    html(`<p>${escaped}</p>`),
    html(escaped.replace("  Next", "<br>Next")),
    html(`<div>${escaped}</div>`),
  ])
    expect(mailReplyState(reply, effect({ ...receipt, body: { html: markup } })).status).toBe(
      "sent",
    );
  const entities = nativeReplyBodyWithText(
    { ...receipt, body: { html: html("&quot;A&quot; &#39;B&#39; &nbsp; &#x43; &#68;") } },
    reply.inReplyTo,
  );
  expect((entities.body as { text?: string }).text?.replace(/\s+/gu, " ")).toBe("\"A\" 'B' C D");
  expect(mailReplyState(reply, effect({ ...receipt, body: { text: reply.body } }))).toMatchObject({
    status: "sent",
  });
});
