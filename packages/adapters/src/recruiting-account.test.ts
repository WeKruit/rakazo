import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRecruitingAccountView } from "./recruiting-account.js";
import * as reads from "./recruiting-reads.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createRepos: vi.fn(),
  createGroupRepos: vi.fn(),
  getRecruitingWorkspace: vi.fn(),
  listRecruitingFeedback: vi.fn(),
  listRecruitingReminders: vi.fn(),
  listRecruitingSchedulingPlans: vi.fn(),
}));
vi.mock("./recruiting-reads.js", async (original) => ({
  ...(await original<typeof reads>()),
  getRecruitingRoleCandidates: vi.fn(),
  getRecruitingRoleCampaign: vi.fn(),
  getRecruitingCorrespondence: vi.fn(),
  getRecruitingCrmData: vi.fn(),
}));
const actor: Actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "recruiter@example.test",
  isDeploymentOwner: false,
};
const role = (id: string, userId = actor.userId, spaceId = actor.spaceId) => ({
  id,
  title: `Role ${id}`,
  sourceThreadId: `thread-${id}`,
  playbookStage: "outreach",
  userId,
  spaceId,
  archivedAt: null,
  sourceThread: { id: `thread-${id}`, botId: `bot-${id}`, groupId: null, userId, spaceId },
});
const rows = [
  role("a"),
  role("b"),
  role("c"),
  role("foreign", "user-b"),
  role("other-space", actor.userId, "space-b"),
];
const routine = (id: string, threadId: string, userId = actor.userId, spaceId = actor.spaceId) => ({
  id,
  threadId,
  botId: `main-${threadId}`,
  userId,
  spaceId,
  name: "Saved routine",
  prompt: "Review saved replies",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-10-30T00:00:00Z"),
});
const routines = [
  routine("routine-a", "thread-a"),
  routine("routine-b", "thread-b"),
  routine("routine-global", "global-main"),
  routine("routine-foreign", "thread-foreign", "user-b"),
  routine("routine-other-space", "thread-other-space", actor.userId, "space-b"),
];
const match = (row: ReturnType<typeof role>, where: Record<string, unknown>) =>
  row.userId === where.userId &&
  row.spaceId === where.spaceId &&
  (!where.id ||
    (typeof where.id === "string"
      ? row.id === where.id
      : row.id > (where.id as { gt: string }).gt));
function fixture() {
  const prisma = {
    routine: {
      findMany: vi.fn(async ({ where, take }) =>
        routines
          .filter(
            (row) =>
              row.userId === where.userId &&
              row.spaceId === where.spaceId &&
              (!where.threadId || row.threadId === where.threadId) &&
              (!where.id?.gt || row.id > where.id.gt),
          )
          .slice(0, take),
      ),
    },
    externalEffect: { findMany: vi.fn(async () => []) },
    run: {
      findMany: vi.fn(async ({ where }) =>
        where.threadId.in.includes("thread-a") ? [{ id: "run-waiting-a" }] : [],
      ),
    },
    recruitingCandidate: {
      groupBy: vi.fn(async ({ where }) =>
        where.roleId.in
          .filter((id: string) => id === "a")
          .map((roleId: string) => ({ roleId, _count: { _all: where.shortlisted ? 3 : 120 } })),
      ),
    },
    message: {
      groupBy: vi.fn(async ({ where }) =>
        where.threadId.in
          .filter((id: string) => id === "thread-a")
          .map((threadId: string) => ({
            threadId,
            _max: { createdAt: new Date("2026-10-30T12:00:00Z") },
          })),
      ),
      findMany: vi.fn(async ({ where }) =>
        where.runId.in.includes("run-waiting-a")
          ? [
              {
                threadId: "thread-a",
                blocks: [{ kind: "ask", status: "pending", text: "Approve the first email?" }],
              },
            ]
          : [],
      ),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }) => rows.find((row) => match(row, where)) ?? null),
      findMany: vi.fn(async ({ where, take }) =>
        rows.filter((row) => match(row, where)).slice(0, take),
      ),
    },
  } as unknown as PrismaClient;
  const deps = { prisma, artifacts: {} as never, connectors: {} as never };
  return { prisma, deps };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.createRepos).mockReturnValue({
    getBot: async (_actor: Actor, id: string) => ({ id, thread: { id: `thread-${id.slice(4)}` } }),
  } as never);
  vi.mocked(db.getRecruitingWorkspace).mockImplementation(
    async (_prisma, _actor, { threadId }) =>
      ({
        role: {
          id: threadId.slice(7),
          spaceId: actor.spaceId,
          userId: actor.userId,
          sourceThreadId: threadId,
          title: `Role ${threadId.slice(7)}`,
          revision: 1,
          currentRevisionId: `revision-${threadId.slice(7)}`,
        },
        revision: {
          id: `revision-${threadId.slice(7)}`,
          roleId: threadId.slice(7),
          revision: 1,
          sourceRefs: [],
          criteria: [],
          preferences: [],
          definitionQuestions: [],
          createdAt: "2026-10-30T00:00:00Z",
        },
        crmTarget: null,
      }) as never,
  );
  vi.mocked(db.listRecruitingFeedback).mockResolvedValue({ feedback: [], nextCursor: null });
  vi.mocked(db.listRecruitingReminders).mockResolvedValue({ items: [], overdueCount: 0 });
  vi.mocked(db.listRecruitingSchedulingPlans).mockResolvedValue({
    plans: [],
    slots: [],
    partial: false,
  });
  vi.mocked(reads.getRecruitingRoleCandidates).mockResolvedValue({
    items: [],
    nextCursor: null,
    total: 0,
    counts: { shortlisted: 0, replied: 0 },
    crmStatus: "not_bound",
  });
  vi.mocked(reads.getRecruitingRoleCampaign).mockResolvedValue({
    status: "none",
    serverId: null,
    campaign: null,
    leads: [],
  });
  vi.mocked(reads.getRecruitingCorrespondence).mockResolvedValue({
    roleId: "a",
    status: "empty",
    checkedAt: null,
    connectionChanged: false,
    connections: [],
    emails: [],
    events: [],
    contacts: [],
    partial: false,
    nextCursor: null,
  });
});
describe("account recruiting reads", () => {
  it("pages all native recruiting routines across distinct bots including global Main in one owned query", async () => {
    const { deps, prisma } = fixture();
    const first = await readRecruitingAccountView(deps, actor, { view: "routines", limit: 2 });
    expect(first.roles.map((role) => role.id)).toEqual(["a", "b", "c"]);
    expect(first.routines?.map((item) => item.id)).toEqual(["routine-a", "routine-b"]);
    expect(first.nextCursor).toBe("routine-b");
    expect(first.routines?.[0]).toMatchObject({
      threadId: "thread-a",
      createdAt: "2026-10-30T00:00:00.000Z",
    });
    expect(prisma.routine.findMany).toHaveBeenCalledExactlyOnceWith({
      take: 3,
      skip: 0,
      orderBy: { id: "asc" },
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
        thread: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          group: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
        },
      },
    });
    const second = await readRecruitingAccountView(deps, actor, {
      view: "routines",
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.routines?.map((item) => item.id)).toEqual(["routine-global"]);
    expect(second.nextCursor).toBeNull();
    expect(db.getRecruitingWorkspace).not.toHaveBeenCalled();
  });
  it("filters routine reads by canonical role identity and refuses foreign roles before listing routines", async () => {
    const { deps, prisma } = fixture();
    const selected = await readRecruitingAccountView(deps, actor, {
      view: "routines",
      roleId: "a",
      limit: 20,
    });
    expect(selected.routines?.map((item) => item.threadId)).toEqual(["thread-a"]);
    expect(
      (
        await readRecruitingAccountView(deps, actor, {
          view: "routines",
          roleId: "a",
          cursor: "routine-a",
          limit: 20,
        })
      ).routines,
    ).toEqual([]);
    vi.mocked(prisma.routine.findMany).mockClear();
    await expect(
      readRecruitingAccountView(deps, actor, { view: "routines", roleId: "foreign", limit: 20 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    const other = await readRecruitingAccountView(
      deps,
      { ...actor, userId: "user-b" },
      { view: "routines", limit: 20 },
    );
    expect(other.routines?.map((item) => item.id)).toEqual(["routine-foreign"]);
  });
  it("paginates active roles while retaining a full owned role picker", async () => {
    const { deps } = fixture();
    const first = await readRecruitingAccountView(deps, actor, { view: "roles", limit: 2 });
    expect(first.roles.map((role) => role.id)).toEqual(["a", "b", "c"]);
    expect(first.items.map((item) => item.roleId)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("b");
    const second = await readRecruitingAccountView(deps, actor, {
      view: "roles",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.roleId)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
  });
  it("reports each role's status from saved records for the global agent", async () => {
    const { deps, prisma } = fixture();
    const view = await readRecruitingAccountView(deps, actor, { view: "roles", limit: 2 });
    expect(view.items).toEqual([
      {
        roleId: "a",
        status: {
          savedPeople: 120,
          shortlisted: 3,
          lastActivityAt: "2026-10-30T12:00:00.000Z",
          waitingOnYou: { kind: "question", text: "Approve the first email?" },
        },
      },
      {
        roleId: "b",
        status: { savedPeople: 0, shortlisted: 0, lastActivityAt: null, waitingOnYou: null },
      },
    ]);
    // Every status read stays inside this user's Space.
    for (const call of vi.mocked(prisma.recruitingCandidate.groupBy).mock.calls)
      expect(call[0]?.where).toMatchObject({ role: { spaceId: "space-a", userId: "user-a" } });
    expect(vi.mocked(prisma.run.findMany).mock.calls[0]?.[0]?.where).toMatchObject({
      thread: { spaceId: "space-a", userId: "user-a" },
    });
  });
  it("rejects a global role cursor when one role is selected", async () => {
    const { deps } = fixture();
    await expect(
      readRecruitingAccountView(deps, actor, {
        view: "roles",
        roleId: "a",
        cursor: "a",
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("never exposes another user or Space and rejects an explicit foreign role", async () => {
    const { deps } = fixture();
    for (const roleId of ["foreign", "other-space", "missing"])
      await expect(
        readRecruitingAccountView(deps, actor, { view: "roles", roleId, limit: 20 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const other = await readRecruitingAccountView(
      deps,
      { ...actor, userId: "user-b" },
      { view: "roles", limit: 20 },
    );
    expect(other.roles.map((role) => role.id)).toEqual(["foreign"]);
  });
  for (const view of [
    "feedback",
    "shortlist",
    "contacts",
    "sequence",
    "inbox",
    "interview",
    "tasks",
  ] as const)
    it(`reads ${view} through the same authorized role services`, async () => {
      const { deps } = fixture();
      const result = await readRecruitingAccountView(deps, actor, { view, roleId: "a", limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.roleId).toBe("a");
      expect(db.getRecruitingWorkspace).toHaveBeenCalledWith(deps.prisma, actor, {
        threadId: "thread-a",
      });
      const key = {
        feedback: "feedback",
        shortlist: "candidates",
        contacts: "candidates",
        sequence: "campaigns",
        inbox: "correspondence",
        interview: "scheduling",
        tasks: "reminders",
      }[view];
      expect(result.items[0]).toHaveProperty(key);
    });
  it("passes candidate pagination only to the exact selected role", async () => {
    const { deps } = fixture();
    await readRecruitingAccountView(deps, actor, {
      view: "shortlist",
      roleId: "a",
      limit: 20,
      itemCursor: "saved-candidate-cursor",
    });
    expect(reads.getRecruitingRoleCandidates).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ threadId: "thread-a" }),
      expect.objectContaining({ cursor: "saved-candidate-cursor", shortlistedOnly: true }),
    );
    await expect(
      readRecruitingAccountView(deps, actor, {
        view: "shortlist",
        limit: 20,
        itemCursor: "cursor",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("reuses the fetched full workspace and keeps inbox email cursors out of candidate paging", async () => {
    const { deps } = fixture();
    const result = await readRecruitingAccountView(deps, actor, {
      view: "inbox",
      roleId: "a",
      limit: 20,
      itemCursor: "200",
    });
    expect(result.items[0]?.workspace).toMatchObject({
      role: { id: "a" },
      crmTarget: null,
      revision: { id: "revision-a" },
    });
    expect(result.items[0]?.candidates).toBeDefined();
    expect(db.getRecruitingWorkspace).toHaveBeenCalledTimes(1);
    expect(reads.getRecruitingRoleCandidates).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.anything(),
      { threadId: "thread-a", limit: 50 },
    );
    expect(reads.getRecruitingCorrespondence).toHaveBeenCalledWith(
      deps.prisma,
      actor,
      expect.anything(),
      "inbox",
      undefined,
      undefined,
      { limit: 200, cursor: "200" },
      expect.anything(),
    );
  });
  it("passes an interview event cursor to the shared correspondence read", async () => {
    const { deps } = fixture();
    await readRecruitingAccountView(deps, actor, {
      view: "interview",
      roleId: "a",
      itemCursor: "200",
      limit: 20,
    });
    expect(reads.getRecruitingCorrespondence).toHaveBeenCalledWith(
      deps.prisma,
      actor,
      expect.anything(),
      "interview",
      undefined,
      undefined,
      { limit: 200, cursor: "200" },
      expect.anything(),
    );
    expect(reads.getRecruitingRoleCandidates).not.toHaveBeenCalled();
  });
  it("passes the selected role's feedback cursor to the native feedback list", async () => {
    const { deps } = fixture();
    await readRecruitingAccountView(deps, actor, {
      view: "feedback",
      roleId: "a",
      itemCursor: "feedback-next",
      limit: 20,
    });
    expect(db.listRecruitingFeedback).toHaveBeenCalledExactlyOnceWith(deps.prisma, actor, {
      roleId: "a",
      limit: 50,
      before: "feedback-next",
    });
  });
  it("filters shortlist dates before paging instead of hiding rows after the page", async () => {
    const { deps } = fixture();
    await readRecruitingAccountView(deps, actor, {
      view: "shortlist",
      roleId: "a",
      limit: 20,
      since: "2026-10-01T00:00:00Z",
    });
    expect(reads.getRecruitingRoleCandidates).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.anything(),
      expect.objectContaining({ shortlistedSince: "2026-10-01T00:00:00Z" }),
    );
  });
  it("includes roleless reminders in global Tasks without leaking them into a filtered role", async () => {
    const { deps } = fixture();
    vi.mocked(db.listRecruitingReminders).mockImplementation(async (_prisma, _actor, input) => ({
      items: input.roleId
        ? []
        : [
            {
              id: "task",
              roleId: null,
              candidateKey: null,
              title: "Follow up",
              note: null,
              dueAt: "2026-01-01T00:00:00Z",
              status: "open",
              completedAt: null,
              createdBy: "user",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
      overdueCount: 0,
    }));
    const global = await readRecruitingAccountView(deps, actor, { view: "tasks", limit: 20 });
    expect(global.unassignedReminders?.items).toHaveLength(1);
    const filtered = await readRecruitingAccountView(deps, actor, {
      view: "tasks",
      roleId: "a",
      limit: 20,
    });
    expect(filtered.unassignedReminders).toBeUndefined();
  });
  it.each([false, true])(
    "merges every saved product campaign source with CRM campaigns when bound=%s",
    async (bound) => {
      const { deps, prisma } = fixture();
      if (bound) {
        const workspace = await db.getRecruitingWorkspace(prisma, actor, { threadId: "thread-a" });
        vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
          ...workspace,
          crmTarget: {
            bindingEffectId: null,
            target: {
              mcpServerId: "crm",
              serverRevision: 1,
              organizationId: "00000000-0000-4000-8000-000000000001",
              crmRoleId: "00000000-0000-4000-8000-000000000002",
              crmClientId: "00000000-0000-4000-8000-000000000003",
              clientLabel: "Client",
              roleLabel: "Role a",
            },
          },
        } as never);
        Object.assign(deps, { firstPartyMcpUrl: "https://crm.example.test/mcp" });
      }
      vi.mocked(prisma.externalEffect.findMany).mockResolvedValue([
        { idempotencyKey: "instantly-role-campaign:one:a", result: { campaignId: "one" } },
        { idempotencyKey: "instantly-role-campaign:two:a", result: { campaignId: "two" } },
      ] as never);
      vi.mocked(reads.getRecruitingRoleCampaign).mockImplementation(
        async (_deps, _actor, _target, selection) => ({
          status: "ready",
          serverId: selection?.serverId ?? (bound ? "crm-mail" : "one"),
          campaign: {
            id: selection?.serverId ?? (bound ? "crm-mail" : "one"),
            name: "Outreach",
            eaccount: null,
            status: 1,
            stopOnReply: true,
          },
          leads: [],
          stats: { sent: 3, opened: 2, replied: 1 },
        }),
      );
      const output = await readRecruitingAccountView(deps, actor, {
        view: "sequence",
        roleId: "a",
        limit: 20,
      });
      expect(output.items[0]?.campaigns?.map((campaign) => campaign.serverId)).toEqual(
        bound ? ["crm-mail", "one", "two"] : ["one", "two"],
      );
      expect(reads.getRecruitingRoleCampaign).toHaveBeenCalledWith(
        expect.anything(),
        actor,
        expect.anything(),
        { serverId: "two", campaignId: "two" },
      );
    },
  );
  it("fences a revoked account before returning data", async () => {
    const { deps } = fixture();
    const stillAuthorized = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      readRecruitingAccountView({ ...deps, stillAuthorized }, actor, { view: "roles", limit: 20 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
