import type { AdapterContext, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  gmailReplyRoute,
  mailReplyFromAnchor,
  mailReplyOutcomeInstruction,
  readGmailReplyCard,
  readMailReplyOutcomeReport,
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

describe("verified reply outcome handoff", () => {
  const child = {
    id: "child",
    botId: "outreach",
    sourceMessage: {
      id: "request",
      seq: 10,
      role: "bot",
      botId: "main",
      runId: "parent",
      threadId: "thread",
      blocks: [],
    },
  };
  const current = {
    id: "report-run",
    userId: "owner",
    spaceId: "space",
    threadId: "thread",
    botId: "main",
  };
  const report = {
    kind: "handoff",
    fromBotId: "outreach",
    toBotId: "main",
    hop: 2,
    text: "Progress above",
    report: "completed",
  };
  function setup(change = {}) {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: current.id,
        botId: current.botId,
        sourceMessage: {
          id: "report",
          seq: 13,
          role: "bot",
          botId: "outreach",
          runId: child.id,
          threadId: "thread",
          blocks: [report],
          ...change,
        },
      })
      .mockResolvedValueOnce(child);
    const mailReply = {
      from: "mailbox@example.test",
      to: ["candidate@example.test"],
      cc: [],
      bcc: [],
      subject: "Re: Original",
      body: "Draft",
      status: "needs_approval",
      sentAt: null,
      inReplyTo: {
        sourceId: "source",
        emailId: "anchor",
        threadId: "mail-thread",
        subject: "Original",
        sender: "candidate@example.test",
      },
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "card",
        runId: child.id,
        blocks: [
          {
            kind: "ask",
            text: "Reply",
            approvalEffectId: "private-effect",
            status: "answered",
            actions: [
              { id: "allow", label: "Send" },
              { id: "deny", label: "Discard" },
            ],
            mailReply,
          },
        ],
      },
    ]);
    const effects = vi
      .fn()
      .mockResolvedValue([
        {
          id: "private-effect",
          runId: child.id,
          status: "completed",
          request: {},
          result: { status: "sent_recorded" },
          updatedAt: new Date(),
          run: { status: "completed" },
        },
      ]);
    return {
      db: { run: { findFirst }, message: { findMany }, externalEffect: { findMany: effects } },
      findFirst,
      findMany,
      effects,
    };
  }
  it("reports the real owned card receipt instead of progress, in one effect batch", async () => {
    const h = setup();
    const result = await readMailReplyOutcomeReport(h.db as never, current);
    expect(result?.facts).toEqual([
      { effectId: "private-effect", status: "sent", sentAt: expect.any(String), error: undefined },
    ]);
    expect(result?.text).toContain("verified sent receipt");
    expect(result?.text).not.toMatch(/private-effect|instantly|provider|Progress above/);
    expect(h.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: child.id,
          botId: child.botId,
          spaceId: "space",
          userId: "owner",
          threadId: "thread",
        },
      }),
    );
    expect(h.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: child.id,
          botId: child.botId,
          threadId: "thread",
          thread: { spaceId: "space", userId: "owner" },
          seq: { gt: 10 },
        }),
      }),
    );
    expect(h.effects).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["private-effect"] },
          runId: child.id,
          spaceId: "space",
          run: { spaceId: "space", userId: "owner", threadId: "thread", botId: child.botId },
        }),
      }),
    );
  });
  it.each([
    { role: "user" },
    { botId: "foreign" },
    { runId: null },
    { threadId: "foreign" },
    { blocks: [{ ...report, toBotId: "foreign" }] },
  ])("rejects an unproven report source %j", async (change) => {
    const h = setup(change);
    expect(await readMailReplyOutcomeReport(h.db as never, current)).toBeUndefined();
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.effects).not.toHaveBeenCalled();
  });
  it("does not promote a cached card without an owned receipt", async () => {
    const h = setup();
    h.effects.mockResolvedValue([]);
    expect(await readMailReplyOutcomeReport(h.db as never, current)).toBeUndefined();
  });
});
