import type { Actor, MailReply, ThreadMessage } from "@rakazo/contracts";
import { MailReplySendAnswerSchema } from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalRequest,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { editMailReplyRequest, mailReplyState, projectMailReplyCards } from "./mail-replies.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const draft: MailReply = {
  from: "mailbox@example.test",
  to: ["person@example.test"],
  cc: [],
  bcc: [],
  subject: "Re: Original",
  body: "Draft",
  inReplyTo: {
    sourceId: "source",
    emailId: "anchor",
    threadId: "thread",
    subject: "Original",
    sender: "person@example.test",
  },
  status: "needs_approval",
  sentAt: null,
};
const args = {
  reply_to_uuid: "anchor",
  eaccount: draft.from,
  to: draft.to[0],
  subject: draft.subject,
  body_text: "Draft",
  body_html: "<p>Draft</p>",
  skip_validation: false,
};
describe("the existing reply approval", () => {
  it("reuses the already-authorized effect batch without another database read", async () => {
    const findMany = vi.fn(async () => {
      throw new Error("Unexpected duplicate receipt read");
    });
    const message = {
      id: "message",
      runId: "run",
      blocks: [
        {
          kind: "ask",
          text: "Reply",
          approvalEffectId: "effect",
          status: "pending",
          mailReply: draft,
          actions: [
            { id: "allow", label: "Send" },
            { id: "deny", label: "Discard" },
          ],
        },
      ],
    } as ThreadMessage;
    const rows = [
      {
        id: "effect",
        runId: "run",
        status: "intended",
        request: args,
        result: null,
        updatedAt: new Date(),
        run: { status: "waiting_input" },
      },
    ];
    expect(
      (
        await projectMailReplyCards(
          { externalEffect: { findMany } } as never,
          actor,
          [message],
          rows,
        )
      )[0]?.blocks[0],
    ).toMatchObject({ mailReply: { status: "needs_approval", canAnswer: true } });
    await projectMailReplyCards({ externalEffect: { findMany } } as never, actor, [message], []);
    expect(findMany).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "changes only body and Cc on the same native request, catalog=%s",
    (catalog) => {
      const route = {
        connectorId: "mcp",
        resourceId: "source",
        resourceRevision: 1,
        toolName: "reply_to_email",
      };
      const original = catalog
        ? catalogApprovalRequest(
            "mcp_execute_tool",
            { id: "source:reply_to_email", arguments: args },
            "__rakazoCatalogTool",
            route,
          )
        : boundDirectApprovalRequest(route, args, "__rakazoCatalogTool");
      const edited = editMailReplyRequest(original, draft, {
        action: "send",
        body: "Edited sentence",
        cc: ["copy@example.test"],
      });
      const details =
        boundDirectApprovalDetails(edited, "__rakazoCatalogTool") ??
        catalogApprovalDetails(edited, "__rakazoCatalogTool")!;
      const body = catalog ? details.args.arguments : details.args;
      expect(body).toEqual({
        ...args,
        body_text: "Edited sentence",
        body_html: undefined,
        cc_address_email_list: "copy@example.test",
      });
      expect(details.route).toEqual(route);
      expect(args.body_text).toBe("Draft");
    },
  );
  it.each(["reply_to_email", "native_instantly_reply_to_email"])(
    "keeps same-address sender edits scoped and omits empty Cc from the %s request",
    (toolName) => {
      const route = { connectorId: "mcp", resourceId: "source", resourceRevision: 1, toolName };
      const request = boundDirectApprovalRequest(
        route,
        {
          ...args,
          eaccount: " MAILBOX@EXAMPLE.TEST ",
          body: { text: "Draft" },
          cc_address_email_list: "old-copy@example.test",
        },
        "__rakazoCatalogTool",
      );
      const edited = editMailReplyRequest(request, draft, {
        action: "send",
        body: "Edited",
        cc: [],
      });
      const details = boundDirectApprovalDetails(edited, "__rakazoCatalogTool");
      expect(details?.route).toEqual(route);
      expect(details?.args).not.toHaveProperty("cc_address_email_list");
      expect(details?.args).toMatchObject({
        reply_to_uuid: "anchor",
        eaccount: draft.from,
        to: draft.to[0],
        subject: draft.subject,
      });
    },
  );
  it("rejects mutable mailbox/To fields and poisoned Cc", () => {
    expect(
      MailReplySendAnswerSchema.safeParse({
        action: "send",
        body: "Edited",
        cc: [],
        to: "other@example.test",
      }).success,
    ).toBe(false);
    expect(
      MailReplySendAnswerSchema.safeParse({
        action: "send",
        body: "Edited",
        cc: ["copy@example.test\r\nBcc:secret@example.test"],
      }).success,
    ).toBe(false);
    const request = boundDirectApprovalRequest(
      { connectorId: "mcp", resourceId: "source", toolName: "reply_to_email" },
      { ...args, eaccount: "other@example.test" },
      "__rakazoCatalogTool",
    );
    expect(() =>
      editMailReplyRequest(request, draft, { action: "send", body: "Edited", cc: [] }),
    ).toThrow();
  });
  it.each([
    ["denied", "discarded"],
    ["approved", "sending"],
    ["executing", "sending"],
    ["failed", "failed"],
    ["uncertain", "unknown"],
    ["completed", "unknown"],
  ] as const)(
    "projects %s from the retained effect, never from the answer alone",
    async (status, expected) => {
      const findMany = vi.fn(async () => [
        {
          id: "effect",
          runId: "run",
          status,
          request: args,
          result: null,
          updatedAt: new Date(),
          run: { status: "waiting_input" },
        },
      ]);
      const message = {
        id: "message",
        runId: "run",
        blocks: [
          {
            kind: "ask",
            approvalEffectId: "effect",
            text: "Reply",
            status: "answered",
            answer: "allow",
            mailReply: draft,
            actions: [
              { id: "allow", label: "Send" },
              { id: "deny", label: "Discard" },
            ],
          },
        ],
      } as ThreadMessage;
      const projected = await projectMailReplyCards(
        { externalEffect: { findMany } } as never,
        actor,
        [message],
      );
      expect(projected[0]?.blocks[0]).toMatchObject({ mailReply: { status: expected } });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: "space",
            run: { userId: "owner", spaceId: "space" },
          }),
        }),
      );
    },
  );
});

it.each([
  ["completed", "sender_unavailable", "failed", "sender_unavailable"],
  ["completed", "private-provider-tool-id", "failed", "send_failed"],
  ["uncertain", "private-provider-tool-id", "unknown", "delivery_unconfirmed"],
] as const)(
  "projects safe reply failure %s/%s",
  async (status, error, expectedStatus, expectedError) => {
    const message = {
      id: "message",
      runId: "run",
      blocks: [
        {
          kind: "ask",
          approvalEffectId: "effect",
          text: "Mail",
          status: "answered",
          mailReply: draft,
        },
      ],
    } as ThreadMessage;
    const rows = await projectMailReplyCards(
      {
        externalEffect: {
          findMany: vi.fn(async () => [
            {
              id: "effect",
              runId: "run",
              status,
              request: args,
              result: { error },
              updatedAt: new Date(),
              run: { status: "completed" },
            },
          ]),
        },
      } as never,
      actor,
      [message],
    );
    expect(rows[0]!.blocks[0]).toMatchObject({
      mailReply: { status: expectedStatus, error: expectedError, canAnswer: false },
    });
    expect(JSON.stringify(rows)).not.toContain("private-provider-tool-id");
  },
);

it("verifies the native REST text-only HTML body without matching titles, quoted text, or different recipients", () => {
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
  const effect = (payload: Prisma.JsonObject) => ({
    status: "completed",
    request: request as Prisma.JsonArray,
    result: { structuredContent: { source: "local_native_instantly_rest", result: payload } },
    updatedAt: new Date("2026-11-02T02:36:20Z"),
  });
  expect(mailReplyState(reply, effect(receipt))).toMatchObject({
    status: "sent",
    sentAt: "2026-11-02T02:36:20.000Z",
  });
  for (const changed of [
    { body: { html: html("Different reply", escaped) } },
    { body: { html: html(`<blockquote>${escaped}</blockquote>`) } },
    { body: { html: html(`<p>${escaped}</p>`) } },
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
  expect(mailReplyState(reply, effect({ ...receipt, body: { text: reply.body } }))).toMatchObject({
    status: "sent",
  });
});
