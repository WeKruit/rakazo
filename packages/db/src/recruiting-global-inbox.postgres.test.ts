import { randomUUID } from "node:crypto";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { inboxThreadKey } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  projectRecruitingInboxMessages,
  readGlobalRecruitingInbox,
} from "./recruiting-global-inbox.js";
import { markRecruitingInbox } from "./recruiting-inbox.js";

const url = process.env.INBOX_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("stored global Inbox projection", () => {
  const db = createDb(url!);
  const prisma = db.prisma;
  const suffix = randomUUID();
  const actors = ["first", "other"].map((name) => ({
    userId: `inbox-${name}-${suffix}`,
    spaceId: `inbox-space-${name}-${suffix}`,
    email: `${name}@example.test`,
    isDeploymentOwner: false,
  }));
  const actor = actors[0]!;
  const roleId = actor.userId;
  const message = (
    id: string,
    extra: Partial<RecruitingCorrespondence["emails"][number]> = {},
  ): RecruitingCorrespondence["emails"][number] => ({
    id,
    sourceId: "source",
    sourceName: "Work mail",
    providerMessageId: id,
    providerThreadId: id,
    eaccount: "host@example.test",
    campaignId: null,
    savedRead: null,
    direction: "received",
    sender: "candidate@example.test",
    recipients: ["host@example.test"],
    subject: `Subject ${id}`,
    body: `Full ${id} needleHiddenWord`,
    snippet: false,
    date: "2026-10-01T10:00:00Z",
    url: null,
    ...extra,
  });
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.startsWith("/rakazo_a2_rls_inbox"))
      throw new Error("Requires isolated local Inbox fixture database");
    for (const a of actors) {
      await prisma.user.create({ data: { id: a.userId, name: "Synthetic", email: a.email } });
      await prisma.organization.create({
        data: { id: a.spaceId, name: "Synthetic", slug: a.spaceId, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id: a.spaceId, organizationId: a.spaceId, name: "Synthetic" },
      });
      await prisma.member.create({
        data: {
          id: a.userId,
          organizationId: a.spaceId,
          userId: a.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await prisma.bot.create({
        data: {
          id: a.userId,
          userId: a.userId,
          spaceId: a.spaceId,
          name: "Synthetic",
          color: "blue",
        },
      });
      await prisma.thread.create({
        data: { id: a.userId, userId: a.userId, spaceId: a.spaceId, botId: a.userId },
      });
      await prisma.$transaction(async (tx) => {
        await tx.recruitingRole.create({
          data: {
            id: a.userId,
            userId: a.userId,
            spaceId: a.spaceId,
            sourceThreadId: a.userId,
            title: "Synthetic role",
            revision: 1,
            currentRevisionId: a.userId,
          },
        });
        await tx.recruitingRoleRevision.create({
          data: {
            id: a.userId,
            roleId: a.userId,
            revision: 1,
            sourceRefs: [],
            criteria: [],
            preferences: [],
            definitionQuestions: [],
          },
        });
        await tx.thread.update({
          where: { id: a.userId },
          data: { activeRecruitingRoleId: a.userId },
        });
      });
    }
  });
  afterAll(async () => {
    for (const a of actors) {
      await prisma.organization.deleteMany({ where: { id: a.spaceId } });
      await prisma.user.deleteMany({ where: { id: a.userId } });
    }
    await prisma.$disconnect();
    await db.pool.end();
  });
  const read = (
    input: Partial<Parameters<typeof readGlobalRecruitingInbox>[2]> = {},
    a: Actor = actor,
  ) => readGlobalRecruitingInbox(prisma, a, { limit: 50, ...input });
  it("preserves complete bodies and attachments after a later partial observation, with bounded search", async () => {
    const full = message("retained", {
      attachments: [{ id: "file", name: "resume.pdf", mimeType: "application/pdf", size: 40 }],
    });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [full],
      observedAt: new Date("2026-10-02T00:00:00Z"),
    });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [{ ...full, body: "Preview", snippet: true, attachments: undefined }],
      observedAt: new Date("2026-10-03T00:00:00Z"),
    });
    const page = await read({ query: "needleHiddenWord" });
    expect(page.items).toHaveLength(1);
    const detail = await read({ thread: { roleId, key: page.items[0]!.key } });
    expect(detail.items[0]?.email.body).toBe(full.body);
    expect(detail.items[0]?.email.attachments).toEqual(full.attachments);
    expect(detail.items[0]?.email.snippet).toBe(false);
  });
  it("keeps equal campaign/message IDs in different sources and organizations separate", async () => {
    const base = message("collision", {
      campaignId: "same-campaign",
      providerMessageId: "same-message",
    });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [
        base,
        {
          ...base,
          sourceId: "other-source",
          attachments: [
            { id: "other-file", name: "other.pdf", mimeType: "application/pdf", size: 10 },
          ],
        },
      ],
      observedAt: new Date("2026-10-04T00:00:00Z"),
    });
    const page = await read({ query: "collision" });
    expect(page.items).toHaveLength(2);
    expect(
      page.items.find((row) => row.email.sourceId === "source")?.email.attachments,
    ).toBeUndefined();
  });
  it("never returns another owner or space, and rolls back a projection whose authorization was revoked", async () => {
    expect((await read({}, actors[1]!)).items).toEqual([]);
    expect((await read({}, { ...actor, spaceId: actors[1]!.spaceId })).items).toEqual([]);
    await expect(
      projectRecruitingInboxMessages(
        prisma,
        actor,
        { roleId, emails: [message("revoked")], observedAt: new Date() },
        async () => {
          throw new Error("revoked");
        },
      ),
    ).rejects.toThrow("revoked");
    expect((await read({ query: "Subject revoked" })).items).toEqual([]);
  });
  it("backfills bounded import receipts and applies the latest exact correction across pages", async () => {
    await prisma.task.create({
      data: {
        id: roleId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        threadId: roleId,
        botId: roleId,
        prompt: "Synthetic",
        status: "completed",
      },
    });
    await prisma.run.create({
      data: {
        id: roleId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        threadId: roleId,
        botId: roleId,
        taskId: roleId,
        status: "completed",
        trigger: "tool_background",
        initialRecruitingRoleRevisionId: roleId,
      },
    });
    for (const [index, emails] of [
      Array.from({ length: 51 }, (_, i) => message(`import-${i}`, { body: `Original ${i}` })),
      [
        message("import-0", {
          body: "Corrected original",
          attachments: [
            { id: "corrected-file", name: "correct.pdf", mimeType: "application/pdf", size: 1 },
          ],
        }),
      ],
    ].entries()) {
      await prisma.externalEffect.create({
        data: {
          id: `receipt-${index}-${suffix}`,
          spaceId: actor.spaceId,
          runId: roleId,
          kind: "recruiting_history_import",
          status: "completed",
          idempotencyKey: `receipt-${index}-${suffix}`,
          createdAt: new Date(`2026-10-0${index + 5}T00:00:00Z`),
          request: { roleId },
          result: {
            version: 1,
            roleId,
            sourceSha256: "a".repeat(64),
            importedAt: "2026-10-01T00:00:00Z",
            emails,
            events: [],
            contacts: [],
          },
        },
      });
    }
    expect((await read()).coverage.importsComplete).toBe(false);
    const complete = await read({ query: "Corrected original" });
    expect(complete.coverage.importsComplete).toBe(true);
    expect(complete.items).toHaveLength(1);
    expect(complete.items[0]?.email.imported).toBe(true);
    expect(complete.items[0]?.email.attachments?.[0]?.id).toBe("corrected-file");
    const first = await read({ limit: 10 });
    const second = await read({ limit: 10, cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map((row) => row.key)).size).toBe(20);
  });
  it("counts only stored incoming after the fixed baseline and shares read cursors across role aliases", async () => {
    const now = new Date();
    await prisma.recruitingInboxInitialization.update({
      where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
      data: { initializedAt: new Date(now.getTime() - 60_000) },
    });
    const incoming = message("fresh", { date: new Date(now.getTime() - 1000).toISOString() });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [incoming, message("sent", { direction: "sent", date: now.toISOString() })],
      observedAt: now,
    });
    expect((await read()).unread.count).toBe(1);
    await markRecruitingInbox(prisma, actor, {
      thread: {
        sourceId: "source",
        organizationId: null,
        mailbox: "host@example.test",
        threadId: "fresh",
      },
      observedIncomingAt: incoming.date!,
      unread: false,
    });
    expect((await read()).unread.count).toBe(0);
    expect((await read()).coverage.providerComplete).toBe(false);
    expect(
      inboxThreadKey({
        sourceId: "source",
        organizationId: null,
        mailbox: "host@example.test",
        threadId: "fresh",
      }),
    ).toBe(
      (
        await prisma.recruitingInboxCursor.findFirst({
          where: { userId: actor.userId, spaceId: actor.spaceId },
        })
      )?.threadKey,
    );
  });
});
