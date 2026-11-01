import { type MailReply, MailReplySchema } from "@rakazo/contracts";
import { createDb, provisionMessagingIdentity } from "@rakazo/db";
import { expect, it } from "vitest";
import { loadMessagePage } from "./thread-message-pages.js";

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "filters exact reply anchors before server pagination, including drafts older than recent chat history",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const address = `+1666${Math.floor(Math.random() * 9000000 + 1000000)}`;
    let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
    try {
      identity = await provisionMessagingIdentity(
        db.prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      );
      const draft: MailReply = {
        from: "sender@example.test",
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "Re: Interview",
        body: "Reviewed reply",
        status: "needs_approval",
        sentAt: null,
        inReplyTo: {
          sourceId: "owned-mail",
          threadId: "exact-thread",
          emailId: "anchor",
          subject: "Interview",
          sender: "recipient@example.test",
        },
      };
      await db.prisma.message.createMany({
        data: Array.from({ length: 120 }, (_, index) => ({
          id: `mail-page-${index}-${address}`,
          threadId: identity!.threadId,
          botId: identity!.botId,
          role: "bot",
          seq: 1000 + index,
          blocks: [
            {
              kind: "ask",
              text: "Review reply",
              status: "pending",
              mailReply: MailReplySchema.parse({
                ...draft,
                from:
                  index === 110
                    ? "other@example.test"
                    : index === 20
                      ? "\tSender@Example.Test\u00a0"
                      : draft.from,
                inReplyTo: {
                  ...draft.inReplyTo,
                  sourceId: [0, 10, 20, 110].includes(index) ? "owned-mail" : "other-mail",
                },
              }),
            },
          ],
        })),
      });
      const first = await loadMessagePage(
        db.prisma,
        identity.threadId,
        undefined,
        2,
        undefined,
        true,
        false,
        { sourceId: "owned-mail", mailbox: " SENDER@EXAMPLE.TEST ", threadId: "exact-thread" },
      );
      expect(first.messages.map((message) => message.seq)).toEqual([1010, 1020]);
      expect(first.olderCursor).toBe(1010);
      const older = await loadMessagePage(
        db.prisma,
        identity.threadId,
        first.olderCursor!,
        2,
        undefined,
        true,
        false,
        { sourceId: "owned-mail", mailbox: " SENDER@EXAMPLE.TEST ", emailIds: ["anchor"] },
      );
      expect(older.messages.map((message) => message.seq)).toEqual([1000]);
      expect(older.olderCursor).toBeNull();
    } finally {
      if (identity) {
        await db.prisma.messagingIdentity.deleteMany({ where: { address } });
        await db.prisma.organization.deleteMany({ where: { id: identity.spaceId } });
        await db.prisma.user.deleteMany({ where: { id: identity.userId } });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
