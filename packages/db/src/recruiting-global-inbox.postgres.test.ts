import { randomUUID } from "node:crypto";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import { GlobalRecruitingInboxOutputSchema, inboxThreadKey } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  indexRecruitingInboxBatch,
  projectRecruitingInboxMessages,
  readGlobalRecruitingInbox,
  readGlobalRecruitingInboxSummary,
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
    email: `${name}-${suffix}@example.test`,
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
      emails: [
        {
          ...full,
          body: "Preview",
          snippet: true,
          attachments: [{ ...full.attachments![0]!, name: "corrected-resume.pdf" }],
        },
      ],
      observedAt: new Date("2026-10-03T00:00:00Z"),
    });
    const page = await read({ query: "needleHiddenWord" });
    expect(page.items).toHaveLength(1);
    const detail = await read({ thread: { roleId, key: page.items[0]!.key } });
    expect(detail.items[0]?.email.body).toBe(full.body);
    expect(detail.items[0]?.email.attachments).toEqual([
      { ...full.attachments![0]!, name: "corrected-resume.pdf" },
    ]);
    expect(detail.items[0]?.email.snippet).toBe(false);
  });
  it("retains original attachments from older observations without downgrading newer content or descriptors", async () => {
    for (const duplicate of [false, true]) {
      const id = `out-of-order-${duplicate}`;
      const newer = message(id, {
        body: "Newest retained canonical body",
        date: "2026-10-04T00:00:00Z",
        ...(duplicate
          ? {
              attachments: [
                { id: "shared", name: "newer.pdf", mimeType: "application/pdf", size: 20 },
              ],
            }
          : {}),
      });
      await projectRecruitingInboxMessages(prisma, actor, {
        roleId,
        emails: [newer],
        observedAt: new Date("2026-10-05T00:00:00Z"),
      });
      await projectRecruitingInboxMessages(prisma, actor, {
        roleId,
        emails: [
          {
            ...newer,
            body: "Older obsolete body",
            date: "2026-10-01T00:00:00Z",
            attachments: [
              { id: "original", name: "original.pdf", mimeType: "application/pdf", size: 10 },
              ...(duplicate
                ? [{ id: "shared", name: "older.pdf", mimeType: "application/pdf", size: 5 }]
                : []),
            ],
          },
        ],
        observedAt: new Date("2026-10-02T00:00:00Z"),
      });
      const row = (await read({ query: `Subject ${id}` })).items[0]!;
      expect(row.email.body).toBe(newer.body);
      expect(row.email.date).toBe(newer.date);
      expect(row.email.attachments?.find((file) => file.id === "original")?.name).toBe(
        "original.pdf",
      );
      if (duplicate)
        expect(row.email.attachments?.find((file) => file.id === "shared")?.name).toBe("newer.pdf");
      const retained = await prisma.recruitingInboxMessage.findFirstOrThrow({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          email: { path: ["id"], equals: id },
        },
      });
      expect(retained.observedAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
      expect(retained.searchText).toContain(newer.body);
      expect(retained.searchText).not.toContain("Older obsolete body");
    }
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
  it("searches outbound text within an incoming thread while keeping its incoming card and excluding sent-only threads", async () => {
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      observedAt: new Date(),
      emails: [
        message("search-incoming", {
          providerThreadId: "search-conversation",
          body: "Incoming reply",
        }),
        message("search-outbound", {
          providerThreadId: "search-conversation",
          direction: "sent",
          body: "outboundUniqueNeedle",
          date: "2026-10-02T00:00:00Z",
        }),
        message("search-sent-only", { direction: "sent", body: "outboundUniqueNeedle" }),
      ],
    });
    const page = await read({ query: "outboundUniqueNeedle" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.email.id).toBe("search-incoming");
    expect(page.items[0]?.email.body).toBe("Incoming reply");
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
  it("distinguishes a new empty corpus from an owned role awaiting background indexing", async () => {
    const other = actors[1]!;
    expect((await readGlobalRecruitingInboxSummary(prisma, other)).coverage).toMatchObject({
      importsComplete: false,
      crmComplete: false,
      providerComplete: false,
    });
    await prisma.recruitingRole.update({
      where: { id: other.userId },
      data: { archivedAt: new Date() },
    });
    try {
      const empty = await read({}, other);
      expect(empty.items).toEqual([]);
      expect(empty.coverage).toMatchObject({
        importsComplete: true,
        crmComplete: true,
        providerComplete: false,
      });
      expect((await readGlobalRecruitingInboxSummary(prisma, other)).coverage).toMatchObject({
        importsComplete: true,
        crmComplete: true,
      });
      expect(
        await prisma.recruitingInboxInitialization.findUnique({
          where: { userId_spaceId: { userId: other.userId, spaceId: other.spaceId } },
        }),
      ).toBeNull();
    } finally {
      await prisma.recruitingRole.update({
        where: { id: other.userId },
        data: { archivedAt: null },
      });
    }
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
      Array.from({ length: 501 }, (_, i) => message(`import-${i}`, { body: `Original ${i}` })),
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
    expect(await indexRecruitingInboxBatch(prisma, actor)).toMatchObject({
      importsComplete: false,
    });
    const during = await read({ limit: 10 });
    expect(during.nextCursor).not.toBeNull();
    expect(during.coverage.importsComplete).toBe(false);
    expect(await indexRecruitingInboxBatch(prisma, actor)).toMatchObject({ importsComplete: true });
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
  it("refreshes cached persona grades against current role revision and later Reviewer evidence", async () => {
    const candidateKey = "linkedin:/in/synthetic-inbox-profile";
    const original = (await read({ query: "Subject exact-profile" })).items[0]!.person!;
    expect(original.autumn?.ranking).toMatchObject({ grade: "Strong", state: "current" });
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [message("cached-profile", { candidateKey })],
      people: [original],
      observedAt: new Date("2026-10-10T00:00:00Z"),
    });
    const effectId = `new-reviewer-${suffix}`;
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
        artifactId: `candidate-artifact-${suffix}`,
        artifactHash: "b".repeat(64),
        observedAt: new Date("2026-10-11T00:00:00Z"),
        rowCount: 1,
      },
    });
    await prisma.recruitingCandidateOccurrence.create({
      data: {
        pageId: effectId,
        rowIndex: 0,
        roleId,
        candidateKey,
        issues: [],
        matchFields: { match_tier: "Partial", match_score: 55 },
      },
    });
    expect(
      (await read({ query: "Subject cached-profile" })).items[0]?.person?.autumn?.ranking,
    ).toMatchObject({
      grade: "Partial",
      score: 55,
      state: "current",
      roleRevisionId: roleId,
      sourceEffectId: effectId,
    });
    const revision = `${roleId}-revision-2`;
    await prisma.recruitingRoleRevision.create({
      data: {
        id: revision,
        roleId,
        revision: 2,
        sourceRefs: [],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
      },
    });
    await prisma.recruitingRole.update({
      where: { id: roleId },
      data: { currentRevisionId: revision, revision: 2 },
    });
    expect(
      (await read({ query: "Subject cached-profile" })).items[0]?.person?.autumn?.ranking,
    ).toMatchObject({ grade: "Partial", state: "outdated", roleRevisionId: roleId });
  });
  it("indexes 24,000 saved messages off-request while reads remain read-only and page immediately", async () => {
    const before = await prisma.recruitingInboxMessage.count({
      where: { userId: actor.userId, spaceId: actor.spaceId },
    });
    const receiptId = `large-receipt-${suffix}`;
    await prisma.externalEffect.create({
      data: {
        id: receiptId,
        spaceId: actor.spaceId,
        runId: roleId,
        kind: "recruiting_history_import",
        status: "completed",
        idempotencyKey: receiptId,
        request: { roleId },
        result: {
          version: 1,
          roleId,
          sourceSha256: "c".repeat(64),
          importedAt: "2026-10-09T00:00:00Z",
          emails: Array.from({ length: 24_000 }, (_, i) =>
            message(`volume-${String(i).padStart(5, "0")}`),
          ),
          events: [],
          contacts: [],
        },
      },
    });
    const writesBefore = await prisma.recruitingInboxIndexProgress.findUnique({
      where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
    });
    await read({ limit: 1 });
    await readGlobalRecruitingInboxSummary(prisma, actor);
    expect(
      await prisma.recruitingInboxMessage.count({
        where: { userId: actor.userId, spaceId: actor.spaceId },
      }),
    ).toBe(before);
    expect(
      await prisma.recruitingInboxIndexProgress.findUnique({
        where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
      }),
    ).toEqual(writesBefore);
    expect(
      await prisma.recruitingInboxInitialization.findUnique({
        where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
      }),
    ).toBeNull();
    let chunks = 0;
    do {
      const coverage = await indexRecruitingInboxBatch(prisma, actor);
      chunks++;
      if (chunks === 1) {
        const page = await read({ query: "Subject volume", limit: 50 });
        expect(page.items).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
        expect(page.coverage.importsComplete).toBe(false);
      }
      if (coverage.importsComplete && coverage.crmComplete) break;
    } while (chunks < 100);
    expect(chunks).toBe(48);
    expect(
      await prisma.recruitingInboxMessage.count({
        where: { userId: actor.userId, spaceId: actor.spaceId, receiptId },
      }),
    ).toBe(24_000);
    const first = await read({ query: "Subject volume", limit: 50 });
    const second = await read({ query: "Subject volume", limit: 50, cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map((row) => row.key)).size).toBe(100);
    // A numbered page reads only its rows and carries the full count of matching threads.
    expect(first.total).toBe(24_000);
    expect(second.total).toBeNull();
    const jumped = await read({ query: "Subject volume", limit: 50, offset: 50 });
    expect(jumped.items.map((row) => row.key)).toEqual(second.items.map((row) => row.key));
    expect(jumped.total).toBe(24_000);
    const last = await read({ query: "Subject volume", limit: 50, offset: 23_990 });
    expect(last.items).toHaveLength(10);
    expect(last.nextCursor).toBeNull();
    expect(first.coverage.importsComplete).toBe(true);
    expect(
      await prisma.recruitingInboxInitialization.findUnique({
        where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
      }),
    ).toBeNull();
  }, 120_000);
  it("counts only stored incoming after the fixed baseline and shares read cursors across role aliases", async () => {
    const now = new Date();
    await prisma.recruitingInboxInitialization.upsert({
      where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
      create: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        initializedAt: new Date(now.getTime() - 60_000),
      },
      update: { initializedAt: new Date(now.getTime() - 60_000) },
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
  it("opens the exact owned original email beyond both the first thread page and the first message page", async () => {
    const query = "Original anchor lookup fixture";
    const original = message("display-original-anchor", {
      providerMessageId: "original-provider-anchor",
      providerThreadId: "old-anchor-thread",
      subject: query,
      body: "Exact full original body",
      date: "2025-01-01T00:00:00Z",
    });
    const newerThreads = Array.from({ length: 51 }, (_, index) =>
      message(`anchor-new-thread-${index}`, { subject: query, date: "2026-10-20T00:00:00Z" }),
    );
    const newerMessages = Array.from({ length: 51 }, (_, index) =>
      message(`anchor-new-message-${index}`, {
        subject: query,
        providerThreadId: "old-anchor-thread",
        date: "2026-10-19T00:00:00Z",
      }),
    );
    await projectRecruitingInboxMessages(prisma, actor, {
      roleId,
      emails: [original, ...newerThreads, ...newerMessages],
      observedAt: new Date("2026-10-21T00:00:00Z"),
    });
    const key = inboxThreadKey({
      sourceId: "source",
      organizationId: null,
      mailbox: "host@example.test",
      threadId: "old-anchor-thread",
    });
    const first = await read({ query, roleId });
    expect(first.items).toHaveLength(50);
    expect(first.items.some((row) => row.key === key)).toBe(false);
    const defaultThread = await read({ thread: { roleId, key } });
    expect(defaultThread.items).toHaveLength(50);
    expect(
      defaultThread.items.some((row) => row.email.providerMessageId === original.providerMessageId),
    ).toBe(false);
    const exact = await read({ thread: { roleId, key, emailId: original.providerMessageId! } });
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0]?.email).toMatchObject({
      id: original.id,
      providerMessageId: original.providerMessageId,
      body: original.body,
      snippet: false,
    });
    expect(exact.nextCursor).toBeNull();
    expect(
      (await read({ thread: { roleId, key, emailId: original.providerMessageId! } }, actors[1]!))
        .items,
    ).toEqual([]);
    expect(
      (
        await read({
          thread: { roleId: actors[1]!.userId, key, emailId: original.providerMessageId! },
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await read({
          thread: {
            roleId,
            key: inboxThreadKey({
              sourceId: "other-source",
              organizationId: null,
              mailbox: "host@example.test",
              threadId: "old-anchor-thread",
            }),
            emailId: original.providerMessageId!,
          },
        })
      ).items,
    ).toEqual([]);
    expect((await read({ thread: { roleId, key, emailId: original.id } })).items).toEqual([]);
  });
});
