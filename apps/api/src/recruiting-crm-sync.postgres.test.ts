import { ORPCError } from "@orpc/server";
import type { Actor, RecruitingCrmDataInput, RecruitingCrmDataOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, listSyncedRecruitingCrmRoleContacts } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordCrmRoleRead, syncRecruitingCrm } from "./recruiting-crm-sync.js";
import type { ThreadTarget } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const ORG = "00000000-0000-4000-8000-000000000001";
const ROLE_A = "00000000-0000-4000-8000-0000000000a1";
const ROLE_B = "00000000-0000-4000-8000-0000000000b1";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const person = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Contact = Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"][number];
const contact = (n: number, patch: Partial<Contact> = {}): Contact => ({
  candidateId: person(n),
  name: `Person ${n}`,
  email: `p${n}@example.test`,
  phone: null,
  linkedinUrl: `https://www.linkedin.com/in/person-${n}/`,
  location: "New York",
  title: "Engineer",
  stage: null,
  contactStatus: "found",
  outreachStatus: "not contacted",
  roleSpecId: ROLE_A,
  legacyClientLabel: "Client",
  legacyRoleLabel: "Role A",
  interest: "unknown",
  reviewed: false,
  lastReplyAt: null,
  resumeReceived: false,
  company: "Example Company",
  profile: {
    history: [{ company: "Previous Company", title: "Engineer", start: "2020" }],
    summary: "Stored profile",
    skills: ["TypeScript"],
    sources: [],
  },
  ...patch,
});

/** A fake CRM behind the same read contract `getRecruitingCrmData` returns. */
function fakeCrm(serverId: string) {
  const state = {
    roles: [
      { crmRoleId: ROLE_A, label: "Role A" },
      { crmRoleId: ROLE_B, label: "Role B" },
    ],
    contacts: [contact(1), contact(2), contact(3, { roleSpecId: ROLE_B })],
    members: { [ROLE_A]: [person(1), person(2)], [ROLE_B]: [person(3)] } as Record<
      string,
      string[]
    >,
    mail: [
      {
        id: "mail-1",
        providerMessageId: "mail-1",
        threadId: "t1",
        direction: "received" as const,
        sender: "p1@example.test",
        recipients: ["owner@example.test"],
        subject: "Re: role",
        body: "Interested",
        date: "2026-10-23T10:00:00.000Z",
        partial: false,
        candidateId: person(1),
      },
    ],
    failLinks: null as string | null,
    reads: 0,
  };
  const source = { serverId, serverRevision: 1, name: "CRM", organizationId: ORG };
  const role = (id: string) => {
    const found = state.roles.find((item) => item.crmRoleId === id)!;
    return {
      crmRoleId: id,
      clientId: CLIENT,
      clientLabel: "Client",
      roleLabel: found.label,
      summary: null,
    };
  };
  const page = <T>(rows: T[], offset: number, limit: number) => {
    const slice = rows.slice(offset, offset + limit);
    return {
      slice,
      nextOffset:
        slice.length && offset + slice.length < rows.length ? offset + slice.length : null,
    };
  };
  const read = async (input: RecruitingCrmDataInput): Promise<RecruitingCrmDataOutput> => {
    state.reads++;
    const checkedAt = new Date().toISOString();
    if (input.operation === "memberships")
      return {
        operation: "memberships",
        checkedAt,
        sources: [
          {
            serverId,
            serverRevision: 1,
            name: "CRM",
            status: "ready",
            memberships: [{ organizationId: ORG, name: "Org", role: "owner" }],
          },
        ],
      };
    if (input.operation === "roles")
      return {
        operation: "roles",
        source,
        checkedAt,
        items: state.roles.map((item) => role(item.crmRoleId)),
      };
    const limit = 2; // Small pages exercise pagination.
    const offset = "offset" in input ? (input.offset ?? 0) : 0;
    if (input.operation === "presence")
      return {
        operation: "presence",
        source,
        checkedAt,
        candidateIds: input.candidateIds.filter((id) =>
          state.contacts.some((row) => row.candidateId === id),
        ),
        ...(input.crmRoleId
          ? {
              roleCandidateIds: input.candidateIds.filter((id) =>
                state.members[input.crmRoleId!]?.includes(id),
              ),
            }
          : {}),
      };
    if (input.operation === "candidates") {
      if (input.crmRoleId && input.crmRoleId === state.failLinks)
        throw new ORPCError("CONFLICT", { message: "Ambiguous role" });
      const rows = input.crmRoleId
        ? state.contacts.filter((row) => state.members[input.crmRoleId!]?.includes(row.candidateId))
        : state.contacts;
      const { slice, nextOffset } = page(rows, offset, limit);
      return {
        operation: "candidates",
        source,
        checkedAt,
        scope: input.crmRoleId ? "legacy_role_labels" : "organization",
        selectedRole: input.crmRoleId ? role(input.crmRoleId) : null,
        items: slice,
        total: rows.length,
        offset,
        nextOffset,
        nextCursor: nextOffset === null ? null : String(nextOffset),
      };
    }
    if (input.operation === "roleMail") {
      const rows = state.mail.filter((row) =>
        state.members[input.crmRoleId]?.includes(row.candidateId),
      );
      const { slice, nextOffset } = page(rows, offset, limit);
      return {
        operation: "roleMail",
        source,
        checkedAt,
        scope: "stored_role_correspondence",
        crmRoleId: input.crmRoleId,
        supported: true,
        items: slice,
        offset,
        nextOffset,
        nextCursor: nextOffset === null ? null : String(nextOffset),
      };
    }
    throw new Error(`unexpected ${input.operation}`);
  };
  return { state, read };
}

describePostgres("CRM sync (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `crm-sync-owner-${suffix}`;
  const otherUserId = `crm-sync-other-${suffix}`;
  const organizationId = `crm-sync-org-${suffix}`;
  const spaceId = `crm-sync-space-${suffix}`;
  const actor: Actor = { userId, spaceId, email: "owner@example.test", isDeploymentOwner: false };
  const other: Actor = { ...actor, userId: otherUserId, email: "other@example.test" };
  const target = { kind: "bot", threadId: "t", botId: "b" } as ThreadTarget;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let serverId: string;
  let otherServerId: string;
  let crm: ReturnType<typeof fakeCrm>;

  /** Runs the sync to completion, one bounded slice per call, as a caller loop would. */
  async function runAll(who: Actor, read: typeof crm.read, dryRun = false) {
    let cursor: string | undefined;
    let calls = 0;
    for (;;) {
      calls++;
      // A zero budget forces one read per call, so the cursor carries every step.
      const result = await syncRecruitingCrm(
        {
          prisma,
          connectors: {
            execute: () => {
              throw new Error("unused");
            },
          },
          reauthorize: async () => target,
        },
        who,
        target,
        { dryRun, ...(cursor ? { cursor } : {}) },
        { read, budgetMs: 0 },
      );
      if (!result.nextCursor) return { ...result, calls };
      cursor = result.nextCursor;
    }
  }
  const slice = (
    who: Actor,
    input: { cursor?: string; dryRun?: boolean } = {},
    read = crm.read,
    chosenTarget = target,
  ) =>
    syncRecruitingCrm(
      {
        prisma,
        connectors: {
          execute: () => {
            throw new Error("unused");
          },
        },
        reauthorize: async () => chosenTarget,
      },
      who,
      chosenTarget,
      input,
      { read, budgetMs: 0 },
    );
  const scoped = (who: Actor) => ({ userId: who.userId, spaceId: who.spaceId });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.createMany({
      data: [
        { id: userId, name: "Owner", email: `${userId}@example.test` },
        { id: otherUserId, name: "Other", email: `${otherUserId}@example.test` },
      ],
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Space" } });
    const server = (owner: string, slug: string) =>
      prisma.mcpServer.create({
        data: { spaceId, userId: owner, slug, name: "CRM", transport: "streamable_http" },
      });
    serverId = (await server(userId, `crm-${suffix}`)).id;
    otherServerId = (await server(otherUserId, `crm-other-${suffix}`)).id;
  });
  beforeEach(async () => {
    for (const who of [userId, otherUserId]) {
      await prisma.recruitingCrmMessage.deleteMany({ where: { userId: who } });
      await prisma.recruitingCrmContact.deleteMany({ where: { userId: who } });
      await prisma.recruitingCrmRole.deleteMany({ where: { userId: who } });
    }
    crm = fakeCrm(serverId);
  });
  afterAll(async () => {
    await prisma?.space.deleteMany({ where: { id: spaceId } });
    await prisma?.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma?.organization.deleteMany({ where: { id: organizationId } });
    await close?.();
  });

  it("dry run reports what a real run then writes, and a re-run changes nothing", async () => {
    const dry = await runAll(actor, crm.read, true);
    expect(dry).toMatchObject({
      dryRun: true,
      organizations: 1,
      roles: { seen: 2, created: 2 },
      contacts: { seen: 3, created: 3, archived: 0 },
      links: { seen: 3, created: 3 },
      messages: { seen: 1, created: 1 },
      skipped: [],
    });
    expect(dry.calls).toBeGreaterThan(5);
    expect(await prisma.recruitingCrmContact.count({ where: scoped(actor) })).toBe(0);

    const real = await runAll(actor, crm.read);
    const { calls: _dryCalls, startedAt: _dryStart, ...dryCounts } = dry;
    const { calls: _calls, startedAt: _start, ...realCounts } = real;
    expect(realCounts).toEqual({ ...dryCounts, dryRun: false });
    const stored = await prisma.recruitingCrmContact.findMany({
      where: scoped(actor),
      orderBy: { crmCandidateId: "asc" },
    });
    expect(stored[0]).toMatchObject({ company: "Example Company", profile: contact(1).profile });
    expect(stored.map((row) => [row.name, row.identityKey, row.crmRoleId])).toEqual([
      ["Person 1", "li:linkedin.com/in/person-1", ROLE_A],
      ["Person 2", "li:linkedin.com/in/person-2", ROLE_A],
      ["Person 3", "li:linkedin.com/in/person-3", ROLE_B],
    ]);
    expect(await prisma.recruitingCrmRoleContact.count({ where: { contact: scoped(actor) } })).toBe(
      3,
    );
    expect(await prisma.recruitingCrmMessage.findFirst({ where: scoped(actor) })).toMatchObject({
      crmMessageId: "mail-1",
      crmCandidateId: person(1),
      crmRoleId: ROLE_A,
      subject: "Re: role",
    });

    const again = await runAll(actor, crm.read);
    expect(again).toMatchObject({
      roles: { seen: 2, created: 0, updated: 0, unchanged: 2, archived: 0 },
      contacts: { seen: 3, created: 0, updated: 0, unchanged: 3, archived: 0 },
      links: { created: 0, unchanged: 3, archived: 0 },
      messages: { created: 0, unchanged: 1 },
    });
    expect(await prisma.recruitingCrmContact.count({ where: scoped(actor) })).toBe(3);
  });

  it("archives what left the CRM and restores it when it returns, never deleting", async () => {
    await runAll(actor, crm.read);
    crm.state.contacts = [contact(1, { stage: "Interview" }), contact(2)];
    crm.state.members = { [ROLE_A]: [person(1)] };
    crm.state.roles = [{ crmRoleId: ROLE_A, label: "Role A" }];
    const expected = {
      roles: { unchanged: 1, archived: 1 },
      contacts: { updated: 1, unchanged: 1, archived: 1 },
      links: { unchanged: 1, archived: 1 },
    };
    expect(await runAll(actor, crm.read, true)).toMatchObject(expected);
    expect(await runAll(actor, crm.read)).toMatchObject(expected);
    const rows = await prisma.recruitingCrmContact.findMany({ where: scoped(actor) });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.crmCandidateId === person(3))?.archivedAt).not.toBeNull();
    expect(rows.find((row) => row.crmCandidateId === person(1))?.stage).toBe("Interview");

    crm.state.contacts.push(contact(3, { roleSpecId: ROLE_B }));
    expect(await runAll(actor, crm.read)).toMatchObject({ contacts: { restored: 1 } });
    expect(
      await prisma.recruitingCrmContact.count({ where: { ...scoped(actor), archivedAt: null } }),
    ).toBe(3);
  });

  it("leaves a role's links alone when its read fails", async () => {
    await runAll(actor, crm.read);
    crm.state.members = { [ROLE_A]: [], [ROLE_B]: [person(3)] };
    crm.state.failLinks = ROLE_A;
    const result = await runAll(actor, crm.read);
    expect(result.skipped).toEqual([
      { organizationId: ORG, crmRoleId: ROLE_A, step: "links", reason: "Ambiguous role" },
    ]);
    expect(result.links.archived).toBe(0);
    expect(
      await prisma.recruitingCrmRoleContact.count({
        where: { archivedAt: null, contact: scoped(actor) },
      }),
    ).toBe(3);
  });

  it("keeps each user's copy separate", async () => {
    await runAll(actor, crm.read);
    const otherCrm = fakeCrm(otherServerId);
    otherCrm.state.contacts = [];
    otherCrm.state.members = {};
    otherCrm.state.mail = [];
    await runAll(other, otherCrm.read);
    expect(await prisma.recruitingCrmContact.count({ where: scoped(actor) })).toBe(3);
    expect(await prisma.recruitingCrmContact.count({ where: scoped(other) })).toBe(0);
  });

  it("refuses a cursor from a different mode", async () => {
    const first = await syncRecruitingCrm(
      {
        prisma,
        connectors: {
          execute: () => {
            throw new Error("unused");
          },
        },
        reauthorize: async () => target,
      },
      actor,
      target,
      { dryRun: true },
      { read: crm.read, budgetMs: 0 },
    );
    await expect(
      syncRecruitingCrm(
        {
          prisma,
          connectors: {
            execute: () => {
              throw new Error("unused");
            },
          },
          reauthorize: async () => target,
        },
        actor,
        target,
        { cursor: first.nextCursor! },
        { read: crm.read },
      ),
    ).rejects.toThrow("Start the CRM sync again.");
  });

  it("reads projection fields only through active links in the exact owner and role scope", async () => {
    await runAll(actor, crm.read);
    const scope = { mcpServerId: serverId, organizationId: ORG };
    const rows = await listSyncedRecruitingCrmRoleContacts(prisma, actor, scope, ROLE_A);
    expect(rows.map((row) => row.candidateId).sort()).toEqual([person(1), person(2)]);
    expect(rows[0]).toMatchObject({ company: "Example Company", profile: contact(1).profile });
    expect(await listSyncedRecruitingCrmRoleContacts(prisma, other, scope, ROLE_A)).toEqual([]);
    expect(
      await listSyncedRecruitingCrmRoleContacts(
        prisma,
        actor,
        { ...scope, organizationId: person(99) },
        ROLE_A,
      ),
    ).toEqual([]);
    await prisma.recruitingCrmRoleContact.updateMany({
      where: { contact: { crmCandidateId: person(1) } },
      data: { archivedAt: new Date() },
    });
    expect(
      (await listSyncedRecruitingCrmRoleContacts(prisma, actor, scope, ROLE_A)).map(
        (row) => row.candidateId,
      ),
    ).toEqual([person(2)]);
  });

  it("rejects forged, cross-owner, cross-thread, superseded and replayed cursors", async () => {
    const first = await slice(actor, { dryRun: true });
    const token = first.nextCursor!;
    for (const invalid of [
      "forged",
      Buffer.from(JSON.stringify({ offset: 9999 })).toString("base64url"),
    ])
      await expect(slice(actor, { dryRun: true, cursor: invalid })).rejects.toThrow(
        "Start the CRM sync again.",
      );
    await expect(slice(other, { dryRun: true, cursor: token })).rejects.toThrow(
      "Start the CRM sync again.",
    );
    await expect(
      slice(actor, { dryRun: true, cursor: token }, crm.read, { ...target, threadId: "another" }),
    ).rejects.toThrow("Start the CRM sync again.");
    const next = await slice(actor, { dryRun: true, cursor: token });
    await expect(slice(actor, { dryRun: true, cursor: token })).rejects.toThrow(
      "Start the CRM sync again.",
    );
    await slice(actor, { dryRun: true });
    await expect(slice(actor, { dryRun: true, cursor: next.nextCursor! })).rejects.toThrow(
      "Start the CRM sync again.",
    );
    expect(await prisma.recruitingCrmContact.count({ where: scoped(actor) })).toBe(0);
  });

  it("allows exactly one concurrent consumer of a progress token", async () => {
    const first = await slice(actor, { dryRun: true });
    const results = await Promise.allSettled([
      slice(actor, { dryRun: true, cursor: first.nextCursor! }),
      slice(actor, { dryRun: true, cursor: first.nextCursor! }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("revalidates a skipped identity instead of archiving a row shifted between offset pages", async () => {
    await runAll(actor, crm.read);
    let moved = false;
    const read: typeof crm.read = async (input) => {
      if (input.operation === "candidates" && !input.crmRoleId && input.offset === 2 && !moved) {
        moved = true;
        // Row 3 moved before the page boundary. It remains in the CRM.
        crm.state.contacts = [contact(3), contact(1), contact(2)];
      }
      return crm.read(input);
    };
    const result = await runAll(actor, read);
    expect(result.contacts.archived).toBe(0);
    expect(
      await prisma.recruitingCrmContact.count({ where: { ...scoped(actor), archivedAt: null } }),
    ).toBe(3);
  });

  it("creates contacts discovered after the organization pass before linking them", async () => {
    let added = false;
    const read: typeof crm.read = async (input) => {
      if (input.operation === "candidates" && input.crmRoleId && !added) {
        added = true;
        crm.state.contacts.push(contact(4));
        crm.state.members[ROLE_A]!.push(person(4));
      }
      return crm.read(input);
    };
    await runAll(actor, read);
    expect(
      await prisma.recruitingCrmRoleContact.count({
        where: { contact: { ...scoped(actor), crmCandidateId: person(4) } },
      }),
    ).toBe(1);
  });

  it("leaves every row active when a later absence verification batch fails", async () => {
    crm.state.contacts = Array.from({ length: 55 }, (_, i) => contact(i + 1));
    crm.state.members = { [ROLE_A]: [], [ROLE_B]: [] };
    await runAll(actor, crm.read);
    crm.state.contacts = [];
    let checks = 0;
    const read: typeof crm.read = async (input) => {
      if (input.operation === "presence" && !input.crmRoleId && ++checks === 2)
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Unavailable" });
      return crm.read(input);
    };
    const result = await runAll(actor, read);
    expect(result.contacts.archived).toBe(0);
    expect(result.skipped).toContainEqual(expect.objectContaining({ step: "contacts" }));
    expect(
      await prisma.recruitingCrmContact.count({ where: { ...scoped(actor), archivedAt: null } }),
    ).toBe(55);
  });

  it("does not restore an archived row from an older incremental read", async () => {
    await runAll(actor, crm.read);
    const delayedAt = new Date();
    crm.state.contacts = [];
    crm.state.members = { [ROLE_A]: [], [ROLE_B]: [] };
    await runAll(actor, crm.read);
    const archived = await prisma.recruitingCrmContact.findFirstOrThrow({
      where: { ...scoped(actor), crmCandidateId: person(1) },
    });
    await recordCrmRoleRead(
      prisma,
      actor,
      {
        serverId,
        organizationId: ORG,
        role: {
          crmRoleId: ROLE_A,
          clientId: CLIENT,
          clientLabel: "Client",
          roleLabel: "Role A",
          summary: null,
        },
        items: [contact(1)],
        complete: true,
      },
      delayedAt,
    );
    expect(
      await prisma.recruitingCrmContact.findUnique({ where: { id: archived.id } }),
    ).toMatchObject({ archivedAt: archived.archivedAt, syncedAt: archived.syncedAt });
    expect(
      await prisma.recruitingCrmRoleContact.count({
        where: { contact: { ...scoped(actor), crmCandidateId: person(1) }, archivedAt: null },
      }),
    ).toBe(0);
  });

  it("does not overwrite newer incremental data with an older read", async () => {
    const read = {
      serverId,
      organizationId: ORG,
      role: {
        crmRoleId: ROLE_A,
        clientId: CLIENT,
        clientLabel: "Client",
        roleLabel: "Role A",
        summary: null,
      },
      items: [contact(1, { title: "New title" })],
      complete: true,
    };
    await recordCrmRoleRead(prisma, actor, read, new Date("2026-10-23T12:00:00Z"));
    await recordCrmRoleRead(
      prisma,
      actor,
      { ...read, items: [contact(1, { title: "Old title" })] },
      new Date("2026-10-23T11:00:00Z"),
    );
    expect(await prisma.recruitingCrmContact.findFirst({ where: scoped(actor) })).toMatchObject({
      title: "New title",
      syncedAt: new Date("2026-10-23T12:00:00Z"),
    });
  });

  it("records a role list read as an incremental sync", async () => {
    await recordCrmRoleRead(prisma, actor, {
      serverId,
      organizationId: ORG,
      role: {
        crmRoleId: ROLE_A,
        clientId: CLIENT,
        clientLabel: "Client",
        roleLabel: "Role A",
        summary: null,
      },
      items: [contact(1), contact(2)],
      complete: true,
    });
    expect(await prisma.recruitingCrmRole.count({ where: scoped(actor) })).toBe(1);
    expect(await prisma.recruitingCrmRoleContact.count({ where: { contact: scoped(actor) } })).toBe(
      2,
    );
    await recordCrmRoleRead(prisma, actor, {
      serverId,
      organizationId: ORG,
      role: {
        crmRoleId: ROLE_A,
        clientId: CLIENT,
        clientLabel: "Client",
        roleLabel: "Role A",
        summary: null,
      },
      items: [contact(1)],
      complete: true,
    });
    // Offset reads do not prove absence: links are archived only by full sync presence checks.
    expect(
      await prisma.recruitingCrmContact.count({ where: { ...scoped(actor), archivedAt: null } }),
    ).toBe(2);
    expect(
      await prisma.recruitingCrmRoleContact.count({
        where: { archivedAt: null, contact: scoped(actor) },
      }),
    ).toBe(2);
  });
});
