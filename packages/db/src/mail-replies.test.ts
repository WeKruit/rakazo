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

it("uses only the same native POST identity for Sent and displays its actual receipt body", () => {
  const request = boundDirectApprovalRequest(
    { connectorId: "mcp", resourceId: "source", toolName: "native_instantly_reply_to_email" },
    {
      reply_to_uuid: "anchor",
      eaccount: draft.from,
      body: { text: "First\n\nSecond" },
      subject: draft.subject,
    },
    "__rakazoCatalogTool",
  );
  const receipt = {
    id: "new-email",
    ue_type: 3,
    thread_id: "thread",
    eaccount: draft.from,
    subject: draft.subject,
    to_address_email_list: draft.to.join(","),
    cc_address_email_list: "",
    body: { html: "<html><head><title>Not body</title></head><body>First Second</body></html>" },
  };
  const effect = (payload: Prisma.JsonObject, source = "local_native_instantly_rest") => ({
    status: "completed",
    request: request as Prisma.JsonArray,
    result: { structuredContent: { source, result: payload } },
    updatedAt: new Date("2026-11-02T04:32:00Z"),
  });
  for (const [body, expected] of [
    [{ html: "<p>First Second</p>" }, "First Second"],
    [{ html: "<p>First<br><br>Second</p>" }, "First\n\nSecond"],
    [{ html: "<p>First Second</p>", text: "First\n\nSecond" }, "First Second"],
    [
      { html: "<p>Actual 中文 &amp; &lt;text&gt;</p><script>globalThis.ran = true</script>" },
      "Actual 中文 & <text>",
    ],
    [{ text: "Actual plain body" }, "Actual plain body"],
  ] as const) {
    const state = mailReplyState(draft, effect({ ...receipt, body }));
    expect(state).toMatchObject({
      status: "sent",
      body: expected,
      sentAt: "2026-11-02T04:32:00.000Z",
    });
    expect(state.error).toBeUndefined();
    expect((globalThis as Record<string, unknown>).ran).toBeUndefined();
  }
  for (const changed of [
    { id: "anchor" },
    { ue_type: 4 },
    { thread_id: "foreign" },
    { eaccount: "foreign@example.test" },
    { to_address_email_list: "foreign@example.test" },
    { cc_address_email_list: "foreign@example.test" },
    { subject: "foreign" },
  ])
    expect(mailReplyState(draft, effect({ ...receipt, ...changed })).status).toBe("unknown");
  expect(mailReplyState(draft, effect(receipt, "untrusted-source")).status).toBe("unknown");
  expect(
    mailReplyState({ ...draft, inReplyTo: { ...draft.inReplyTo, threadId: null } }, effect(receipt))
      .status,
  ).toBe("unknown");
});
