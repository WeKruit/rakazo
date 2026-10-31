import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  listRecruitingContacts,
  recruitingContactFacets,
  updateRecruitingContactTags,
} from "./recruiting-contacts.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("all-roles contacts (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `contacts-user-${suffix}`;
  const otherUserId = `contacts-other-${suffix}`;
  const spaceId = `contacts-space-${suffix}`;
  const actor = { userId, spaceId, email: "contacts@example.test", isDeploymentOwner: false };
  const other = { ...actor, userId: otherUserId };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  async function role(owner: string, id: string, title: string) {
    const thread = `${id}-thread`;
    await prisma.bot.create({
      data: { id: `${id}-bot`, userId: owner, spaceId, name: "Main", color: "blue" },
    });
    await prisma.thread.create({
      data: { id: thread, userId: owner, spaceId, botId: `${id}-bot` },
    });
    await prisma.$transaction(async (tx) => {
      await tx.recruitingRole.create({
        data: {
          id,
          spaceId,
          userId: owner,
          sourceThreadId: thread,
          title,
          revision: 1,
          currentRevisionId: `${id}-rev`,
        },
      });
      await tx.recruitingRoleRevision.create({
        data: {
          id: `${id}-rev`,
          roleId: id,
          revision: 1,
          criteria: [],
          sourceRefs: [],
          preferences: [],
          definitionQuestions: [],
        },
      });
    });
    await prisma.task.create({
      data: {
        id: `${id}-task`,
        spaceId,
        botId: `${id}-bot`,
        threadId: thread,
        userId: owner,
        prompt: "p",
        status: "completed",
      },
    });
    await prisma.run.create({
      data: {
        id: `${id}-run`,
        spaceId,
        botId: `${id}-bot`,
        threadId: thread,
        taskId: `${id}-task`,
        userId: owner,
        status: "completed",
        trigger: "user",
      },
    });
    await prisma.artifact.create({
      data: {
        id: `${id}-artifact`,
        spaceId,
        userId: owner,
        name: "rows",
        mimeType: "application/json",
        size: 1,
        hash: "a".repeat(64),
        storageKey: `${id}-artifact`,
      },
    });
  }

  async function saved(
    roleId: string,
    page: string,
    observedAt: string,
    people: {
      key: string;
      name: string;
      title?: string;
      company?: string;
      location?: string;
      shortlisted?: boolean;
    }[],
  ) {
    await prisma.externalEffect.create({
      data: {
        id: page,
        spaceId,
        runId: `${roleId}-run`,
        kind: "recruiting_rows",
        idempotencyKey: page,
        status: "completed",
        request: {},
      },
    });
    await prisma.recruitingCandidatePage.create({
      data: {
        effectId: page,
        roleId,
        roleRevisionId: `${roleId}-rev`,
        artifactId: `${roleId}-artifact`,
        artifactHash: "a".repeat(64),
        observedAt: new Date(observedAt),
        rowCount: people.length,
      },
    });
    for (const [rowIndex, person] of people.entries()) {
      await prisma.recruitingCandidate.upsert({
        where: { roleId_candidateKey: { roleId, candidateKey: person.key } },
        create: { roleId, candidateKey: person.key, shortlisted: person.shortlisted ?? false },
        update: {},
      });
      await prisma.recruitingCandidateOccurrence.create({
        data: {
          pageId: page,
          rowIndex,
          roleId,
          candidateKey: person.key,
          name: person.name,
          title: person.title ?? null,
          company: person.company ?? null,
          location: person.location ?? null,
          issues: [],
        },
      });
    }
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [userId, otherUserId])
      await prisma.user.create({ data: { id, name: "Contacts", email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id: spaceId, name: "Contacts", slug: spaceId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId: spaceId, name: "General", isDefault: true },
    });
    await role(userId, `${suffix}-backend`, "Backend Engineer");
    await role(userId, `${suffix}-sales`, "Sales Lead");
    await role(otherUserId, `${suffix}-foreign`, "Someone else's role");
    await saved(`${suffix}-backend`, `${suffix}-p1`, "2026-10-01T00:00:00Z", [
      {
        key: "linkedin:/in/ada",
        name: "Ada Lovelace",
        title: "Staff Engineer",
        company: "Acme",
        location: "Los Angeles",
        shortlisted: true,
      },
      {
        key: "linkedin:/in/bob",
        name: "Bob Stone",
        title: "Backend Engineer",
        company: "Globex",
        location: "New York",
      },
    ]);
    await saved(`${suffix}-sales`, `${suffix}-p2`, "2026-10-05T00:00:00Z", [
      {
        key: "linkedin:/in/ada",
        name: "Ada Lovelace",
        title: "Staff Engineer",
        company: "Acme",
        location: "Los Angeles",
      },
      {
        key: "linkedin:/in/cy",
        name: "Cy 100%_off",
        title: "Account Executive",
        company: "Initech",
      },
    ]);
    await saved(`${suffix}-foreign`, `${suffix}-p3`, "2026-10-05T00:00:00Z", [
      { key: "linkedin:/in/ada", name: "Ada Lovelace (foreign)", title: "Foreign" },
    ]);
    const server = await prisma.mcpServer.create({
      data: {
        userId,
        spaceId,
        name: "Recruiting CRM",
        slug: `crm-${suffix}`,
        transport: "streamable_http",
        endpoint: "https://crm.example.test/mcp",
      },
    });
    const crmRole = await prisma.recruitingCrmRole.create({
      data: {
        spaceId,
        userId,
        mcpServerId: server.id,
        organizationId: "org",
        crmRoleId: "crm-role",
        clientId: "c",
        clientLabel: "Client",
        roleLabel: "Data Lead",
        syncedAt: new Date(),
      },
    });
    const ada = await prisma.recruitingCrmContact.create({
      data: {
        spaceId,
        userId,
        mcpServerId: server.id,
        organizationId: "org",
        crmCandidateId: "11111111-1111-4111-8111-111111111111",
        name: "Ada L.",
        identityKey: "li:linkedin.com/in/ada",
        email: "ada@example.test",
        contactStatus: "contacted",
        outreachStatus: "replied",
        stage: "interviewing",
        clientLabel: "Client",
        roleLabel: "Data Lead",
        syncedAt: new Date(),
        lastReplyAt: new Date("2026-10-20T00:00:00Z"),
        profile: { history: [], summary: "", skills: ["Rust", "Kafka"], sources: [] },
      },
    });
    await prisma.recruitingCrmContact.create({
      data: {
        spaceId,
        userId,
        mcpServerId: server.id,
        organizationId: "org",
        crmCandidateId: "22222222-2222-4222-8222-222222222222",
        name: "Dee Only",
        identityKey: "em:dee@example.test",
        email: "dee@example.test",
        contactStatus: "new",
        outreachStatus: "",
        clientLabel: "Client",
        roleLabel: "Data Lead",
        syncedAt: new Date(),
      },
    });
    await prisma.recruitingCrmRoleContact.create({
      data: { roleId: crmRole.id, contactId: ada.id, syncedAt: new Date() },
    });
    await prisma.recruitingCrmLead.create({
      data: {
        spaceId,
        userId,
        mcpServerId: server.id,
        organizationId: "org",
        crmLeadId: "lead-1",
        crmCandidateId: "11111111-1111-4111-8111-111111111111",
        lastContactAt: new Date("2026-10-10T00:00:00Z"),
        mirrorSyncedAt: new Date(),
        syncedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: spaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });

  it("lists each person once across roles and the CRM, owner-scoped", async () => {
    const page = await listRecruitingContacts(prisma, actor, {});
    expect(page.total).toBe(4);
    expect(page.items.map((item) => item.name)).toEqual([
      "Ada Lovelace",
      "Bob Stone",
      "Cy 100%_off",
      "Dee Only",
    ]);
    const ada = page.items[0]!;
    expect(ada.roles.map((role) => role.title)).toEqual([
      "Backend Engineer",
      "Data Lead",
      "Sales Lead",
    ]);
    expect(ada.status).toBe("interviewing");
    expect(ada.email).toBe("ada@example.test");
    expect(ada.lastContactedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(ada.lastRepliedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(ada.addedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(JSON.stringify(page)).not.toContain("foreign");
    const theirs = await listRecruitingContacts(prisma, other, {});
    expect(theirs.items.map((item) => item.name)).toEqual(["Ada Lovelace (foreign)"]);
  });

  it("filters, sorts and pages in the database", async () => {
    const first = await listRecruitingContacts(prisma, actor, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = await listRecruitingContacts(prisma, actor, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.name)).toEqual(["Cy 100%_off", "Dee Only"]);
    expect(second.nextCursor).toBeNull();
    const names = async (filters: Parameters<typeof listRecruitingContacts>[2]["filters"]) =>
      (await listRecruitingContacts(prisma, actor, { filters })).items.map((item) => item.name);
    expect(await names({ roleIds: [`${suffix}-sales`] })).toEqual(["Ada Lovelace", "Cy 100%_off"]);
    expect(await names({ company: "glob" })).toEqual(["Bob Stone"]);
    expect(await names({ location: "los angeles" })).toEqual(["Ada Lovelace"]);
    expect(await names({ title: "engineer" })).toEqual(["Ada Lovelace", "Bob Stone"]);
    expect(await names({ skills: "kafka" })).toEqual(["Ada Lovelace"]);
    expect(await names({ query: "100%" })).toEqual(["Cy 100%_off"]);
    expect(await names({ query: "%" })).toEqual(["Cy 100%_off"]);
    expect(await names({ contacted: true })).toEqual(["Ada Lovelace"]);
    expect(await names({ replied: false })).toEqual(["Bob Stone", "Cy 100%_off", "Dee Only"]);
    expect(await names({ statuses: ["saved"] })).toEqual(["Bob Stone", "Cy 100%_off"]);
    expect(await names({ shortlisted: true })).toEqual(["Ada Lovelace"]);
    expect(
      await names({ addedAfter: "2026-10-02T00:00:00Z", addedBefore: "2026-10-30T00:00:00Z" }),
    ).toEqual(["Cy 100%_off"]);
    const recent = await listRecruitingContacts(prisma, actor, { sort: "replied" });
    expect(recent.items[0]!.name).toBe("Ada Lovelace");
  });

  it("tags people and filters by tag; another user's tags stay separate", async () => {
    await updateRecruitingContactTags(prisma, actor, {
      personKeys: ["linkedin:/in/bob", "linkedin:/in/cy"],
      add: ["Hot"],
      remove: [],
    });
    await updateRecruitingContactTags(prisma, actor, {
      personKeys: ["linkedin:/in/bob"],
      add: ["Hot"],
      remove: [],
    });
    await updateRecruitingContactTags(prisma, other, {
      personKeys: ["linkedin:/in/ada"],
      add: ["Theirs"],
      remove: [],
    });
    const tagged = await listRecruitingContacts(prisma, actor, { filters: { tags: ["Hot"] } });
    expect(tagged.items.map((item) => [item.name, item.tags])).toEqual([
      ["Bob Stone", ["Hot"]],
      ["Cy 100%_off", ["Hot"]],
    ]);
    await updateRecruitingContactTags(prisma, actor, {
      personKeys: ["linkedin:/in/cy"],
      add: [],
      remove: ["Hot"],
    });
    const facets = await recruitingContactFacets(prisma, actor);
    expect(facets.tags).toEqual(["Hot"]);
    expect(facets.roles.map((role) => role.title)).toEqual([
      "Backend Engineer",
      "Data Lead",
      "Sales Lead",
    ]);
    expect(facets.statuses).toEqual(expect.arrayContaining(["interviewing", "new", "shortlisted"]));
  });

  it("leaves out roles whose chat was archived", async () => {
    const groupId = `${suffix}-archived-group`;
    await prisma.chatGroup.create({
      data: { id: groupId, spaceId, userId, name: "Sales chat", archivedAt: new Date() },
    });
    const thread = `${suffix}-sales-thread`;
    // A thread belongs to a bot or a group, never both.
    await prisma.thread.update({ where: { id: thread }, data: { groupId, botId: null } });
    try {
      const facets = await recruitingContactFacets(prisma, actor);
      expect(facets.roles.map((role) => role.title)).not.toContain("Sales Lead");
      const page = await listRecruitingContacts(prisma, actor, {});
      const titles = page.items.flatMap((item) => item.roles.map((role) => role.title));
      expect(titles).not.toContain("Sales Lead");
      expect(titles).toContain("Backend Engineer");
    } finally {
      await prisma.thread.update({
        where: { id: thread },
        data: { groupId: null, botId: `${suffix}-sales-bot` },
      });
      await prisma.chatGroup.delete({ where: { id: groupId } });
    }
  });
});
