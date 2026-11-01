import { randomUUID } from "node:crypto";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { GlobalRecruitingInboxOutputSchema, inboxThreadKey } from "@rakazo/contracts";
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
        ...["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map(
          (organizationId, index) => ({
            ...base,
            crm: {
              organizationId,
              serverRevision: 1,
              crmRoleId: "00000000-0000-4000-8000-000000000003",
              candidateId: "00000000-0000-4000-8000-000000000004",
              threadId: "collision",
              direction: "received" as const,
            },
            attachments: [
              {
                id: `org-file-${index}`,
                name: `organization-${index}.pdf`,
                mimeType: "application/pdf",
                size: 10,
              },
            ],
          }),
        ),
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
    expect(page.items).toHaveLength(4);
    for (const [index, org] of [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ].entries()) {
      expect(
        page.items
          .find((row) => row.email.crm?.organizationId === org)
          ?.email.attachments?.map((file) => file.id),
      ).toEqual([`org-file-${index}`]);
    }
    expect(
      page.items.find((row) => row.email.sourceId === "source" && !row.email.crm)?.email
        .attachments,
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
  it("maps an exact native saved candidate and current Reviewer grade without reading another owner's profile", async () => {
    const candidateKey = "linkedin:/in/synthetic-inbox-profile";
    const effectId = `candidate-page-${suffix}`;
    const artifactId = `candidate-artifact-${suffix}`;
    await prisma.artifact.create({
      data: {
        id: artifactId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: "Synthetic Reviewer rows",
        mimeType: "application/json",
        size: 1,
        hash: "b".repeat(64),
        storageKey: artifactId,
      },
    });
    await prisma.externalEffect.create({
      data: {
        id: effectId,
        spaceId: actor.spaceId,
        runId: roleId,
        kind: "recruiting_research",
        status: "completed",
        idempotencyKey: effectId,
        request: { operation: "save_grades" },
      },
    });
    await prisma.recruitingCandidatePage.create({
      data: {
        effectId,
        roleId,
        roleRevisionId: roleId,
        artifactId,
        artifactHash: "b".repeat(64),
        observedAt: new Date("2026-10-07T00:00:00Z"),
        rowCount: 1,
      },
    });
    await prisma.recruitingCandidate.create({
      data: {
        roleId,
        candidateKey,
        shortlisted: true,
        shortlistedAt: new Date("2026-10-07T00:00:00Z"),
      },
    });
    await prisma.recruitingCandidateOccurrence.create({
      data: {
        pageId: effectId,
        rowIndex: 0,
        roleId,
        candidateKey,
        name: "Exact Saved Person",
        title: "Platform Engineer",
        location: "Remote",
        linkedinUrl: "https://www.linkedin.com/in/synthetic-inbox-profile",
        issues: [],
        matchFields: { match_tier: "Strong", match_score: 92 },
      },
    });
    for (const owner of actors)
      await prisma.recruitingSavedProfile.create({
        data: {
          spaceId: owner.spaceId,
          ownerUserId: owner.userId,
          personKey: candidateKey,
          provider: "Synthetic saved profile",
          sourceEffectId: effectId,
          fetchedAt: new Date("2026-10-07T00:00:00Z"),
          profile: {
            headline: owner === actor ? "Saved headline" : "PRIVATE FOREIGN PROFILE",
            profileImageUrl:
              owner === actor
                ? "https://assets.example.test/owned-avatar.png"
                : "https://assets.example.test/foreign-avatar.png",
            experience: [
              {
                company_name: owner === actor ? "Owned Company" : "Foreign Company",
                company_url: null,
                company_linkedin_url: null,
                company_industry: null,
                company_size: null,
                is_current: null,
                company_logo_url: null,
                title: "Platform Engineer",
                location: null,
                start_date: null,
                end_date: null,
                description: null,
              },
            ],
            education: [],
          },
        },
      });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [message("exact-profile", { candidateKey })],
      observedAt: new Date("2026-10-08T00:00:00Z"),
    });
    const page = GlobalRecruitingInboxOutputSchema.parse(
      await read({ query: "Subject exact-profile" }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.person).toMatchObject({
      key: `autumn:${candidateKey}`,
      name: "Exact Saved Person",
      title: "Platform Engineer",
      location: "Remote",
      shortlisted: true,
      autumn: {
        candidateKey,
        savedProfile: {
          personKey: candidateKey,
          headline: "Saved headline",
          profileImageUrl: "https://assets.example.test/owned-avatar.png",
          experience: [{ company_name: "Owned Company" }],
        },
        ranking: {
          source: "reviewer",
          state: "current",
          grade: "Strong",
          score: 92,
          roleRevisionId: roleId,
          sourceEffectId: effectId,
        },
      },
    });
    expect(JSON.stringify(page)).not.toContain("PRIVATE FOREIGN PROFILE");
    expect((await read({ query: "Subject exact-profile" }, actors[1]!)).items).toEqual([]);
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
    const aliasRole = `${roleId}-alias`;
    await prisma.bot.create({
      data: {
        id: aliasRole,
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: "Synthetic alias role",
        color: "blue",
      },
    });
    await prisma.thread.create({
      data: { id: aliasRole, userId: actor.userId, spaceId: actor.spaceId, botId: aliasRole },
    });
    await prisma.$transaction(async (tx) => {
      await tx.recruitingRole.create({
        data: {
          id: aliasRole,
          userId: actor.userId,
          spaceId: actor.spaceId,
          sourceThreadId: aliasRole,
          title: "Same mail, second owned role",
          revision: 1,
          currentRevisionId: aliasRole,
        },
      });
      await tx.recruitingRoleRevision.create({
        data: {
          id: aliasRole,
          roleId: aliasRole,
          revision: 1,
          sourceRefs: [],
          criteria: [],
          preferences: [],
          definitionQuestions: [],
        },
      });
      await tx.thread.update({
        where: { id: aliasRole },
        data: { activeRecruitingRoleId: aliasRole },
      });
    });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId: aliasRole,
      emails: [incoming],
      observedAt: now,
    });
    const aliases = await read({ query: "Subject fresh", unreadOnly: true });
    expect(aliases.items.map((row) => row.roleId).sort()).toEqual([roleId, aliasRole].sort());
    expect(new Set(aliases.items.map((row) => row.key)).size).toBe(1);
    expect(aliases.unread.count).toBe(1);
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
    expect((await read({ query: "Subject fresh", unreadOnly: true })).items).toEqual([]);
    expect((await read({ query: "Subject fresh", roleId: aliasRole })).items).toHaveLength(1);
    expect((await read({ query: "Subject fresh" }, actors[1]!)).items).toEqual([]);
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
