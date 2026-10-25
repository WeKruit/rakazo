import { ORPCError } from "@orpc/server";
import type { Actor, RecruitingCrmDataInput, RecruitingCrmDataOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  listSyncedRecruitingCrmRoleContacts,
  listSyncedRecruitingSequenceStats,
  listSyncedRecruitingUnassignedSequences,
} from "@rakazo/db";
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
    campaigns: [
      { id: "camp-a", crmRoleId: ROLE_A as string | null },
      { id: "camp-b", crmRoleId: ROLE_A as string | null },
      // Not mapped to any role: still copied.
      { id: "camp-unmapped", crmRoleId: null as string | null },
    ],
    leads: [
      { id: "lead-1", campaignId: "camp-a", candidateId: person(1) as string | null, replies: 1 },
      { id: "lead-2", campaignId: "camp-a", candidateId: person(2) as string | null, replies: 0 },
      { id: "lead-3", campaignId: "camp-a", candidateId: null as string | null, replies: 0 },
      { id: "lead-4", campaignId: "camp-unmapped", candidateId: null as string | null, replies: 0 },
      // Its sequence was deleted at the source.
      { id: "lead-5", campaignId: null as string | null, candidateId: person(3), replies: 0 },
    ],
    /** People whose label matches an archived role: listed only when asked to include them. */
    archived: [] as Contact[],
    failCampaigns: false,
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
        : input.includeArchived
          ? [...state.contacts, ...state.archived]
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
    if (input.operation === "campaigns") {
      if (state.failCampaigns)
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Campaigns unavailable" });
      const { slice, nextOffset } = page(state.campaigns, offset, limit);
      return {
        operation: "campaigns",
        source,
        checkedAt,
        items: slice.map((row) => ({
          id: row.id,
          name: `Sequence ${row.id}`,
          status: 1,
          crmRoleId: row.crmRoleId,
          clientId: row.crmRoleId ? CLIENT : null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          syncedAt: "2026-10-03T00:00:00.000Z",
        })),
        offset,
        nextOffset,
        nextCursor: nextOffset === null ? null : String(nextOffset),
      };
    }
    if (input.operation === "campaignLeads") {
      const rows = state.leads.filter((row) => row.campaignId === input.campaignId);
      const { slice, nextOffset } = page(rows, offset, limit);
      return {
        operation: "campaignLeads",
        source,
        checkedAt,
        campaignId: input.campaignId,
        items: slice.map((row) => ({
          id: row.id,
          candidateId: row.candidateId,
          status: 1,
          interestStatus: null,
          openCount: 2,
          replyCount: row.replies,
          lastContactAt: "2026-10-04T00:00:00.000Z",
          lastReplyAt: row.replies ? "2026-10-05T00:00:00.000Z" : null,
          syncedAt: "2026-10-03T00:00:00.000Z",
        })),
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
      await prisma.recruitingCrmLead.deleteMany({ where: { userId: who } });
      await prisma.recruitingCrmCampaign.deleteMany({ where: { userId: who } });
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

  it.each(["unsupported", "missing", "denied", "read-failure"])(
    "keeps the required mail phase retryable after %s",
    async (failure) => {
      let result = await slice(actor);
      for (let pages = 0; pages < 20; pages++) {
        const progress = await prisma.recruitingCrmSyncProgress.findUniqueOrThrow({
          where: { userId_spaceId: scoped(actor) },
        });
        if ((progress.progress as { at: { step: string } }).at.step === "mail") break;
        result = await slice(actor, { cursor: result.nextCursor! });
      }
      const before = await prisma.recruitingCrmSyncProgress.findUniqueOrThrow({
        where: { userId_spaceId: scoped(actor) },
      });
      expect((before.progress as { at: { step: string } }).at.step).toBe("mail");
      const read: typeof crm.read = async (input) => {
        if (input.operation !== "roleMail") return crm.read(input);
        if (failure === "unsupported")
          return {
            ...(await crm.read(input)),
            supported: false,
            items: [],
          } as RecruitingCrmDataOutput;
        throw new ORPCError(failure === "denied" ? "FORBIDDEN" : "SERVICE_UNAVAILABLE", {
          message: failure === "missing" ? "Required source tool missing" : "Read refused",
        });
      };
      await expect(slice(actor, { cursor: before.token }, read)).rejects.toMatchObject({
        code: failure === "denied" ? "FORBIDDEN" : "SERVICE_UNAVAILABLE",
      });
      expect(
        await prisma.recruitingCrmSyncProgress.findUniqueOrThrow({
          where: { userId_spaceId: scoped(actor) },
        }),
      ).toEqual(before);
      expect(await prisma.recruitingCrmMessage.count({ where: scoped(actor) })).toBe(0);
      const retry = await slice(actor, { cursor: before.token });
      expect(retry.messages.created).toBeGreaterThan(0);
    },
  );
  it("dry run reports what a real run then writes, and a re-run changes nothing", async () => {
    const dry = await runAll(actor, crm.read, true);
    expect(dry).toMatchObject({
      dryRun: true,
      organizations: 1,
      roles: { seen: 2, created: 2 },
      contacts: { seen: 3, created: 3, archived: 0 },
      links: { seen: 3, created: 3 },
      messages: { seen: 1, created: 1 },
      campaigns: { seen: 3, created: 3 },
      leads: { seen: 5, created: 5 },
      skipped: [],
    });
    expect(dry.calls).toBeGreaterThan(5);
    expect(await prisma.recruitingCrmCampaign.count({ where: scoped(actor) })).toBe(0);
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

    expect(
      await prisma.recruitingCrmCampaign.findFirst({
        where: { ...scoped(actor), crmCampaignId: "camp-unmapped" },
      }),
    ).toMatchObject({ crmRoleId: null, clientId: null, name: "Sequence camp-unmapped" });
    expect(
      await prisma.recruitingCrmLead.findMany({
        where: scoped(actor),
        orderBy: { crmLeadId: "asc" },
        select: { crmLeadId: true, crmCampaignId: true, crmCandidateId: true, replyCount: true },
      }),
    ).toEqual([
      { crmLeadId: "lead-1", crmCampaignId: "camp-a", crmCandidateId: person(1), replyCount: 1 },
      { crmLeadId: "lead-2", crmCampaignId: "camp-a", crmCandidateId: person(2), replyCount: 0 },
      { crmLeadId: "lead-3", crmCampaignId: "camp-a", crmCandidateId: null, replyCount: 0 },
      { crmLeadId: "lead-4", crmCampaignId: "camp-unmapped", crmCandidateId: null, replyCount: 0 },
      { crmLeadId: "lead-5", crmCampaignId: null, crmCandidateId: person(3), replyCount: 0 },
    ]);

    const scope = { mcpServerId: serverId, organizationId: ORG };
    expect(
      await listSyncedRecruitingSequenceStats(prisma, actor, scope, [person(1), person(3)]),
    ).toEqual([
      {
        candidateId: person(1),
        sequences: 1,
        opens: 2,
        replies: 1,
        lastContactAt: "2026-10-04T00:00:00.000Z",
        lastReplyAt: "2026-10-05T00:00:00.000Z",
        status: "active",
        syncedAt: expect.any(String),
      },
      // Only a lead whose sequence was deleted.
      {
        candidateId: person(3),
        sequences: 1,
        opens: 2,
        replies: 0,
        lastContactAt: "2026-10-04T00:00:00.000Z",
        lastReplyAt: null,
        status: "active",
        syncedAt: expect.any(String),
      },
    ]);
    expect(await listSyncedRecruitingUnassignedSequences(prisma, actor, scope)).toEqual([
      {
        id: "camp-unmapped",
        name: "Sequence camp-unmapped",
        status: "active",
        people: 1,
        opened: 1,
        replied: 0,
        lastContactAt: "2026-10-04T00:00:00.000Z",
        syncedAt: expect.any(String),
      },
    ]);
    expect(await listSyncedRecruitingSequenceStats(prisma, other, scope, [person(1)])).toEqual([]);

    const again = await runAll(actor, crm.read);
    expect(again).toMatchObject({
      campaigns: { created: 0, updated: 0, unchanged: 3 },
      leads: { created: 0, updated: 0, unchanged: 5 },
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

  it("copies people hidden from the dashboard on archived roles, and leads without a sequence", async () => {
    crm.state.archived = [contact(4, { roleSpecId: null })];
    const result = await runAll(actor, crm.read);
    expect(result).toMatchObject({ contacts: { created: 4 }, leads: { created: 5 } });
    expect(
      await prisma.recruitingCrmContact.findFirst({
        where: { ...scoped(actor), crmCandidateId: person(4) },
      }),
    ).toMatchObject({ archivedAt: null });
    expect(
      await prisma.recruitingCrmLead.findFirst({
        where: { ...scoped(actor), crmLeadId: "lead-5" },
      }),
    ).toMatchObject({ crmCampaignId: null, crmCandidateId: person(3) });
  });

  it("finishes roles, contacts and mail when the stored campaigns cannot be read", async () => {
    crm.state.failCampaigns = true;
    const result = await runAll(actor, crm.read);
    expect(result.skipped).toEqual([
      { organizationId: ORG, crmRoleId: null, step: "campaigns", reason: "Campaigns unavailable" },
    ]);
    expect(result).toMatchObject({ contacts: { created: 3 }, messages: { created: 1 } });
    // Only the leads without a sequence, which need no campaign list.
    expect(await prisma.recruitingCrmLead.count({ where: scoped(actor) })).toBe(1);
  });

  it("keeps a campaign row when it leaves the CRM, and updates changed lead stats", async () => {
    await runAll(actor, crm.read);
    crm.state.campaigns = crm.state.campaigns.slice(0, 1);
    crm.state.leads = [{ ...crm.state.leads[0]!, replies: 2 }];
    const result = await runAll(actor, crm.read);
    expect(result).toMatchObject({
      campaigns: { unchanged: 1, archived: 0 },
      leads: { updated: 1, archived: 0 },
    });
    expect(await prisma.recruitingCrmCampaign.count({ where: scoped(actor) })).toBe(3);
    expect(
      await prisma.recruitingCrmLead.findFirst({
        where: { ...scoped(actor), crmLeadId: "lead-1" },
      }),
    ).toMatchObject({ replyCount: 2 });
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
    expect(rows!.map((row) => row.candidateId).sort()).toEqual([person(1), person(2)]);
    expect(rows![0]).toMatchObject({ company: "Example Company", profile: contact(1).profile });
    expect(await listSyncedRecruitingCrmRoleContacts(prisma, other, scope, ROLE_A)).toBeNull();
    expect(
      await listSyncedRecruitingCrmRoleContacts(
        prisma,
        actor,
        { ...scope, organizationId: person(99) },
        ROLE_A,
      ),
    ).toBeNull();
    await prisma.recruitingCrmRoleContact.updateMany({
      where: { contact: { crmCandidateId: person(1) } },
      data: { archivedAt: new Date() },
    });
    expect(
      (await listSyncedRecruitingCrmRoleContacts(prisma, actor, scope, ROLE_A))!.map(
        (row) => row.candidateId,
      ),
    ).toEqual([person(2)]);
    await prisma.recruitingCrmRoleContact.updateMany({
      where: { contact: { crmCandidateId: person(2) } },
      data: { archivedAt: new Date() },
    });
    // A known synced role with no active links is empty; absent scope remains unknown above.
    expect(await listSyncedRecruitingCrmRoleContacts(prisma, actor, scope, ROLE_A)).toEqual([]);
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
