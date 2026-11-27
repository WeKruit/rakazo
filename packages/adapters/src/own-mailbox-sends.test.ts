import { projectRecruitingInboxMessages } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  ownMailboxSendRecord,
  ownMailboxSendRefusal,
  recordOwnMailboxSend,
} from "./own-mailbox-sends.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  projectRecruitingInboxMessages: vi.fn(async () => undefined),
}));

const context = { spaceId: "w1", userId: "u1", runId: "run-1" };

/** Records an own-mailbox send reads: stops, a role's holds, earlier sends of both kinds. */
function records(input: {
  stopped?: string[];
  held?: { key: string; operation: "hold" | "pass"; email: string }[];
  campaignSends?: { email: string; at: string }[];
  mailboxSends?: { to: string; at: string }[];
}) {
  return {
    run: {
      findFirst: vi.fn(async () => ({
        thread: { activeRecruitingRoleId: input.held ? "role-1" : null },
      })),
    },
    externalEffect: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        const email = where.idempotencyKey.replace("outreach-contact-stop:w1:", "");
        return input.stopped?.includes(email)
          ? { spaceId: "w1", kind: "outreach_contact_stop", status: "completed" }
          : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { kind: unknown } }) =>
        where.kind === "instantly_role_campaign"
          ? [
              {
                result: {
                  leads: Object.fromEntries(
                    (input.held ?? []).map((person) => [person.key, { email: person.email }]),
                  ),
                },
              },
            ]
          : (input.mailboxSends ?? []).map((send) => ({
              result: { structuredContent: { sent: true, to: send.to, messageId: "m" } },
              updatedAt: new Date(send.at),
            })),
      ),
    },
    mcpServer: { findMany: vi.fn(async () => []) },
    recruitingCandidate: {
      findMany: vi.fn(async () =>
        (input.held ?? []).map((person) => ({
          candidateKey: person.key,
          consideration: { operation: person.operation },
          occurrences: [],
        })),
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("").includes("activate_campaign")
        ? (input.campaignSends ?? []).map((send) => ({
            result: { campaignId: "c-1", recipients: [send.email] },
            updatedAt: new Date(send.at),
          }))
        : [],
    ),
  };
}

describe("own-mailbox send checks", () => {
  it("refuses someone the recruiter stopped, before any card", async () => {
    // Audit 11-26: an email from the recruiter's own mailbox skipped every check a campaign makes.
    const prisma = records({ stopped: ["ada@x.test"] });
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "Ada@x.test" }),
    ).resolves.toMatch(/ada@x\.test \(the recruiter asked that they never be contacted again\)/);
    // Even a follow-up in an earlier thread is refused for a stopped person.
    await expect(
      ownMailboxSendRefusal(prisma as never, context, {
        to: "ada@x.test",
        replyThreadId: "abc123",
      }),
    ).resolves.toMatch(/never be contacted again/);
  });

  it("refuses a role's person on hold or passed, matched by the address its records hold", async () => {
    const prisma = records({ held: [{ key: "ada", operation: "hold", email: "ada@x.test" }] });
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "ada@x.test" }),
    ).resolves.toMatch(/on hold for this role/);
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "bob@x.test" }),
    ).resolves.toBeUndefined();
  });

  it("refuses a second new email unless it is a follow-up or the recruiter asked again", async () => {
    const prisma = records({
      campaignSends: [{ email: "ada@x.test", at: "2026-11-20T10:00:00Z" }],
      mailboxSends: [{ to: "Bob@x.test", at: "2026-11-21T10:00:00Z" }],
    });
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "ada@x.test" }),
    ).resolves.toMatch(/already emailed ada@x\.test \(2026-11-20 10:00 UTC/);
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "bob@x.test" }),
    ).resolves.toMatch(/already emailed bob@x\.test \(2026-11-21 10:00 UTC/);
    await expect(
      ownMailboxSendRefusal(prisma as never, context, {
        to: "bob@x.test",
        replyThreadId: "abc123",
      }),
    ).resolves.toBeUndefined();
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "bob@x.test", resend: true }),
    ).resolves.toBeUndefined();
    await expect(
      ownMailboxSendRefusal(prisma as never, context, { to: "cy@x.test" }),
    ).resolves.toBeUndefined();
  });

  it("reads a send's record by the mailbox's own ids, and nothing from a failed send", () => {
    expect(
      ownMailboxSendRecord({
        structuredContent: { sent: true, to: "Ada@x.test", messageId: "m1", threadId: "t1" },
      }),
    ).toEqual({ to: "ada@x.test", messageId: "m1", threadId: "t1" });
    expect(ownMailboxSendRecord({ error: "Email not sent." })).toBeUndefined();
  });

  it("keeps a send from a conversation with no role under that conversation", async () => {
    // A one-off email from the main chat appeared on no page.
    const sent = {
      sourceId: "gmail",
      sourceName: "Gmail",
      mailbox: "me@x.test",
      to: "ada@x.test",
      subject: "Data role",
      body: "Hi",
      messageId: "m1",
      threadId: "t1",
      sentAt: "2026-11-26T10:00:00Z",
    };
    for (const role of [null, "role-1"]) {
      const prisma = {
        run: {
          findFirst: vi.fn(async () => ({ thread: { id: "main", activeRecruitingRoleId: role } })),
        },
      };
      await recordOwnMailboxSend(prisma as never, context, sent);
    }
    const owners = vi
      .mocked(projectRecruitingInboxMessages)
      .mock.calls.map(([, , input]) => [input.roleId, input.conversationId]);
    expect(owners).toEqual([
      [undefined, "main"],
      ["role-1", undefined],
    ]);
  });
});
