import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  createRecruitingReminder,
  deleteRecruitingReminder,
  executeRecruitingRemindersTool,
  listRecruitingReminders,
  updateRecruitingReminder,
} from "./recruiting-reminders.js";
import { IsolationError } from "./scope.js";

const actor = (userId: string): Actor => ({
  spaceId: "space",
  userId,
  email: `${userId}@example.test`,
  isDeploymentOwner: false,
});
const alice = actor("alice");
const bob = actor("bob");
const T = (iso: string) => new Date(iso);
const NOW = T("2026-10-23T12:00:00Z");

/** In-memory delegate honoring the equality / lt filters the layer uses. */
function fake() {
  type R = Record<string, unknown> & { id: string };
  const rows: R[] = [];
  let n = 0;
  const match = (r: R, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "lt" in v
        ? (r[k] as Date) < (v as { lt: Date }).lt
        : v && typeof v === "object" && "in" in v
          ? (v as { in: unknown[] }).in.includes(r[k])
          : r[k] === v,
    );
  const reminder = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const r = {
        status: "open",
        completedAt: null,
        createdAt: NOW,
        ...data,
        id: `r${++n}`,
      } as R;
      rows.push(r);
      return r;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((r) => match(r, where))
        .sort((a, b) => (a.dueAt as Date).getTime() - (b.dueAt as Date).getTime()),
    count: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => match(r, where)).length,
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => match(r, where)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(rows.find((r) => r.id === where.id) as R, data),
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { count: hit.length };
    },
  };
  const recruitingRole = {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "role" && where.userId === "alice" ? { id: "role" } : null,
  };
  return {
    prisma: { recruitingReminder: reminder, recruitingRole } as unknown as PrismaClient,
    rows,
  };
}

describe("recruiting reminders (db)", () => {
  it("creates, lists with overdueCount, and attributes agent creation", async () => {
    const { prisma } = fake();
    const past = await createRecruitingReminder(prisma, alice, {
      title: "Call Sam",
      dueAt: "2026-10-22T00:00:00.000Z",
      candidateKey: "crm:42",
      roleId: "role",
    });
    await createRecruitingReminder(
      prisma,
      alice,
      { title: "Later", dueAt: "2026-11-01T00:00:00.000Z" },
      "bot-1",
    );
    expect(past).toMatchObject({ createdBy: "user", status: "open", completedAt: null });
    const all = await listRecruitingReminders(prisma, alice, {}, NOW);
    expect(all.items.map((i) => i.title)).toEqual(["Call Sam", "Later"]);
    expect(all.items[1]?.createdBy).toBe("agent");
    expect(all.overdueCount).toBe(1);
    const byCandidate = await listRecruitingReminders(
      prisma,
      alice,
      { candidateKey: "crm:42" },
      NOW,
    );
    expect(byCandidate.items).toHaveLength(1);
    const before = await listRecruitingReminders(
      prisma,
      alice,
      { dueBefore: "2026-10-30T00:00:00.000Z" },
      NOW,
    );
    expect(before.items).toHaveLength(1);
  });

  it("lists by several candidate keys (OR) within the owner's scope", async () => {
    const { prisma } = fake();
    const due = "2026-11-01T00:00:00.000Z";
    for (const candidateKey of ["autumn:a", "crm:1", "crm:2"])
      await createRecruitingReminder(prisma, alice, {
        title: candidateKey,
        dueAt: due,
        candidateKey,
      });
    await createRecruitingReminder(prisma, bob, {
      title: "bob",
      dueAt: due,
      candidateKey: "crm:1",
    });
    const both = await listRecruitingReminders(
      prisma,
      alice,
      { candidateKeys: ["autumn:a", "crm:1"] },
      NOW,
    );
    expect(both.items.map((i) => i.title)).toEqual(["autumn:a", "crm:1"]);
    const merged = await listRecruitingReminders(
      prisma,
      alice,
      { candidateKey: "crm:2", candidateKeys: ["crm:1"] },
      NOW,
    );
    expect(merged.items.map((i) => i.title)).toEqual(["crm:1", "crm:2"]);
  });

  it("done sets completedAt and stops counting as overdue; reopen clears it", async () => {
    const { prisma } = fake();
    const r = await createRecruitingReminder(prisma, alice, {
      title: "x",
      dueAt: "2026-10-01T00:00:00.000Z",
    });
    const done = await updateRecruitingReminder(prisma, alice, { id: r.id, status: "done" }, NOW);
    expect(done.completedAt).toBe(NOW.toISOString());
    expect((await listRecruitingReminders(prisma, alice, {}, NOW)).overdueCount).toBe(0);
    const reopened = await updateRecruitingReminder(
      prisma,
      alice,
      { id: r.id, status: "open" },
      NOW,
    );
    expect(reopened.completedAt).toBeNull();
    const edited = await updateRecruitingReminder(prisma, alice, {
      id: r.id,
      title: "y",
      note: null,
    });
    expect(edited).toMatchObject({ title: "y", note: null });
  });

  it("deletes", async () => {
    const { prisma, rows } = fake();
    const r = await createRecruitingReminder(prisma, alice, {
      title: "x",
      dueAt: "2026-10-01T00:00:00.000Z",
    });
    await expect(deleteRecruitingReminder(prisma, alice, r.id)).resolves.toEqual({ ok: true });
    expect(rows).toHaveLength(0);
  });

  it("isolates owners and foreign roles", async () => {
    const { prisma, rows } = fake();
    const r = await createRecruitingReminder(prisma, alice, {
      title: "mine",
      dueAt: "2026-10-01T00:00:00.000Z",
    });
    expect((await listRecruitingReminders(prisma, bob, {}, NOW)).items).toEqual([]);
    await expect(updateRecruitingReminder(prisma, bob, { id: r.id, title: "z" })).rejects.toThrow(
      IsolationError,
    );
    await expect(deleteRecruitingReminder(prisma, bob, r.id)).rejects.toThrow(IsolationError);
    await expect(
      createRecruitingReminder(prisma, bob, {
        title: "t",
        dueAt: "2026-10-01T00:00:00.000Z",
        roleId: "role",
      }),
    ).rejects.toThrow(IsolationError);
    expect(rows).toHaveLength(1);
  });

  it("maps tool operations and tags the run's bot", async () => {
    const { prisma } = fake();
    const created = await executeRecruitingRemindersTool(prisma, alice, "bot-9", {
      operation: "create",
      title: "Follow up",
      dueAt: "2026-10-30T00:00:00.000Z",
    });
    expect(created).toMatchObject({ createdBy: "agent" });
    const listed = await executeRecruitingRemindersTool(prisma, alice, "bot-9", {
      operation: "list",
    });
    expect(listed).toMatchObject({ items: [{ title: "Follow up" }] });
    const id = (created as { id: string }).id;
    expect(
      await executeRecruitingRemindersTool(prisma, alice, "bot-9", {
        operation: "update",
        id,
        status: "dismissed",
      }),
    ).toMatchObject({ status: "dismissed" });
    expect(
      await executeRecruitingRemindersTool(prisma, alice, "bot-9", { operation: "delete", id }),
    ).toEqual({ ok: true });
  });
});
