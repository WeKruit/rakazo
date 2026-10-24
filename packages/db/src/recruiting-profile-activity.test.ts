import type { Actor } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { listRecruitingProfileActivity, recordRecruitingProfileView } from "./recruiting.js";
import { IsolationError } from "./scope.js";

vi.mock("./events.js", () => ({
  appendEventInTransaction: async (
    tx: { event: { create: (input: unknown) => unknown } },
    data: unknown,
  ) => tx.event.create({ data }),
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const target = { roleId: "role", candidateKey: "autumn:person" };
const input = { ...target, viewId: "00000000-0000-4000-8000-000000000001" };
const now = new Date("2026-10-23T12:00:00Z");
type Event = {
  id: string;
  createdAt: Date;
  payload: Record<string, unknown>;
  spaceId: string;
  threadId: string;
  type: string;
};
let events: Event[];
let prisma: PrismaClient;
let tx: ReturnType<typeof fixture>;
function fixture() {
  const owned = (where: Record<string, unknown>) =>
    where.spaceId === "space" && where.userId === "owner";
  const eventMatches = (
    event: Event,
    where: {
      spaceId: string;
      threadId: string;
      type: string;
      thread: { spaceId: string; userId: string };
      AND: Array<{ payload: { path: string[]; equals: unknown } }>;
    },
  ) =>
    owned(where.thread) &&
    event.spaceId === where.spaceId &&
    event.threadId === where.threadId &&
    event.type === where.type &&
    where.AND.every(
      ({ payload }) =>
        event.payload[payload.path[0]!] ===
        (payload.equals === Prisma.JsonNull ? null : payload.equals),
    );
  return {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    recruitingCrmWorkspaceAttachment: { findUnique: vi.fn(async () => null) },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) && where.id === "role"
          ? {
              ...actor,
              id: "role",
              sourceThreadId: "thread",
              crmBindingEffectId: null,
              title: "Engineer",
            }
          : null,
      ),
    },
    thread: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) && where.id === "thread" ? { ...actor, id: "thread", botId: "bot" } : null,
      ),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) ? actor : null,
      ),
    },
    recruitingCandidate: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { roleId_candidateKey: { roleId: string; candidateKey: string } };
        }) =>
          where.roleId_candidateKey.roleId === "role" &&
          where.roleId_candidateKey.candidateKey === "person"
            ? { candidateKey: "person" }
            : null,
      ),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Persisted Recruiter" })) },
    event: {
      findFirst: vi.fn(
        async ({ where }: { where: Parameters<typeof eventMatches>[1] }) =>
          events.find((event) => eventMatches(event, where)) ?? null,
      ),
      findMany: vi.fn(
        async ({ where, take }: { where: Parameters<typeof eventMatches>[1]; take: number }) =>
          events
            .filter((event) => eventMatches(event, where))
            .reverse()
            .slice(0, take),
      ),
      create: vi.fn(async ({ data }: { data: Omit<Event, "id" | "createdAt"> }) => {
        const event = { ...data, id: `event-${events.length + 1}`, createdAt: now };
        events.push(event);
        return event;
      }),
    },
  };
}
beforeEach(() => {
  events = [];
  tx = fixture();
  prisma = {
    $transaction: (body: (value: ReturnType<typeof fixture>) => unknown) => body(tx),
  } as unknown as PrismaClient;
});
it("records authenticated actor/time/context once for the same open and lists it", async () => {
  const first = await recordRecruitingProfileView(prisma, actor, input);
  expect(first).toEqual({
    id: "event-1",
    at: now.toISOString(),
    actorName: "Persisted Recruiter",
    roleTitle: "Engineer",
  });
  expect(await recordRecruitingProfileView(prisma, actor, input)).toEqual(first);
  expect(tx.event.create).toHaveBeenCalledTimes(1);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  expect(await listRecruitingProfileActivity(prisma, actor, target)).toEqual({
    items: [first],
    hasMore: false,
  });
  await recordRecruitingProfileView(prisma, actor, {
    ...input,
    viewId: "00000000-0000-4000-8000-000000000002",
  });
  expect(events).toHaveLength(2);
});
it("rejects foreign owner/space/role/person on both paths without inspecting event content", async () => {
  for (const [identity, chosen] of [
    [{ ...actor, userId: "other" }, target],
    [{ ...actor, spaceId: "other" }, target],
    [actor, { ...target, roleId: "other" }],
    [actor, { ...target, candidateKey: "autumn:missing" }],
    [actor, { ...target, candidateKey: "crm:foreign" }],
  ] as const) {
    await expect(listRecruitingProfileActivity(prisma, identity, chosen)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(
      recordRecruitingProfileView(prisma, identity, { ...chosen, viewId: input.viewId }),
    ).rejects.toBeInstanceOf(IsolationError);
  }
  expect(tx.event.findMany).not.toHaveBeenCalled();
  expect(tx.event.findFirst).not.toHaveBeenCalled();
  expect(tx.event.create).not.toHaveBeenCalled();
});
it("rechecks target ownership after waiting for the write lock", async () => {
  tx.$queryRaw.mockImplementation(async () => {
    tx.recruitingRole.findFirst.mockResolvedValue(null);
    return [];
  });
  await expect(recordRecruitingProfileView(prisma, actor, input)).rejects.toBeInstanceOf(
    IsolationError,
  );
  expect(tx.event.create).not.toHaveBeenCalled();
});
it("filters every list by actor, candidate, role and binding before returning a bounded page", async () => {
  await recordRecruitingProfileView(prisma, actor, input);
  const base = events[0]!;
  events.push(
    { ...base, id: "other-actor", payload: { ...base.payload, actorUserId: "other" } },
    { ...base, id: "other-person", payload: { ...base.payload, candidateKey: "autumn:other" } },
    { ...base, id: "other-role", payload: { ...base.payload, roleId: "other" } },
    {
      ...base,
      id: "other-binding",
      payload: { ...base.payload, crmBindingEffectId: "old-binding" },
    },
  );
  expect(
    (await listRecruitingProfileActivity(prisma, actor, target)).items.map((item) => item.id),
  ).toEqual(["event-1"]);
  for (let n = 0; n < 51; n++) events.push({ ...base, id: `synthetic-${n}` });
  const page = await listRecruitingProfileActivity(prisma, actor, target);
  expect(page.items).toHaveLength(50);
  expect(page.hasMore).toBe(true);
});
