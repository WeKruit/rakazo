import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { gmailReplyRoute, mailReplyFromAnchor, readGmailReplyCard } from "./mail-reply.js";

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
    const draft = await readGmailReplyCard(connector(), route, args, context);
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
        body: { text: "Full draft" },
        cc_address_email_list: "copy@example.test",
      },
      {
        id: "email",
        eaccount: "sender@example.test",
        from_address_email: "candidate@example.test",
        subject: "Original",
        organization_id: "organization",
        thread_id: "provider-thread",
      },
    );
    expect(draft).toMatchObject({
      from: "sender@example.test",
      to: ["candidate@example.test"],
      cc: ["copy@example.test"],
      body: "Full draft",
      inReplyTo: { emailId: "email", inboxKey: expect.any(String) },
    });
  });
});
