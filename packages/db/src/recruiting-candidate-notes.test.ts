import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  createRecruitingCandidateNote,
  deleteRecruitingCandidateNote,
  executeRecruitingNotesTool,
  listRecruitingCandidateNotes,
  updateRecruitingCandidateNote,
} from "./recruiting-candidate-notes.js";
import { IsolationError } from "./scope.js";

const actor = (userId: string): Actor => ({
  spaceId: "space",
  userId,
  email: `${userId}@example.test`,
  isDeploymentOwner: false,
});
const alice = actor("alice");
const bob = actor("bob");
const NOW = new Date("2026-10-23T12:00:00Z");
const users: Record<string, string> = { alice: "Alice", bob: "Bob" };

/** In-memory delegate honoring the equality / `in` filters and owner include the layer uses. */
function fake() {
  type R = Record<string, unknown> & { id: string; createdAt: Date };
  const rows: R[] = [];
  let n = 0;
  const match = (r: R, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in v
        ? (v as { in: unknown[] }).in.includes(r[k])
        : (r[k] ?? null) === v,
    );
  const out = (r: R) => ({ ...r, owner: { name: users[r.ownerUserId as string] } });
  const note = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      n += 1;
      const at = new Date(NOW.getTime() + n * 1000);
      const r = { createdAt: at, updatedAt: at, deletedAt: null, ...data, id: `n${n}` } as R;
      rows.push(r);
      return out(r);
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((r) => match(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(out),
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => match(r, where)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      out(Object.assign(rows.find((r) => r.id === where.id) as R, data)),
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  const recruitingRole = {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "role" && where.userId === "alice" ? { id: "role" } : null,
  };
  const bot = {
    findMany: async ({ where }: { where: { id: { in: string[] }; spaceId: string } }) =>
      where.id.in.includes("bot-1") && where.spaceId === "space"
        ? [{ id: "bot-1", name: "Sourcer" }]
        : [],
  };
  return {
    prisma: { recruitingCandidateNote: note, recruitingRole, bot } as unknown as PrismaClient,
    rows,
  };
}

describe("recruiting candidate notes (db)", () => {
  it("creates and lists newest first across keys with authors", async () => {
    const { prisma } = fake();
    const first = await createRecruitingCandidateNote(prisma, alice, {
      candidateKey: "autumn:k1",
      roleId: "role",
      body: "Strong Go background",
    });
    await createRecruitingCandidateNote(
      prisma,
      alice,
      { candidateKey: "crm:42", body: "Prefers remote" },
      "bot-1",
    );
    await createRecruitingCandidateNote(prisma, alice, { candidateKey: "crm:99", body: "Other" });
    expect(first).toMatchObject({ createdBy: "user", authorName: "Alice", roleId: "role" });
    const listed = await listRecruitingCandidateNotes(prisma, alice, {
      candidateKeys: ["autumn:k1", "crm:42"],
    });
    expect(listed.items.map((i) => i.body)).toEqual(["Prefers remote", "Strong Go background"]);
    expect(listed.items[0]).toMatchObject({ createdBy: "agent", authorName: "Sourcer" });
    const byRole = await listRecruitingCandidateNotes(prisma, alice, {
      candidateKeys: ["autumn:k1", "crm:42"],
      roleId: "role",
    });
    expect(byRole.items).toHaveLength(1);
  });

  it("edits and soft-deletes", async () => {
    const { prisma, rows } = fake();
    const note = await createRecruitingCandidateNote(prisma, alice, {
      candidateKey: "crm:42",
      body: "x",
    });
    const edited = await updateRecruitingCandidateNote(prisma, alice, { id: note.id, body: "y" });
    expect(edited.body).toBe("y");
    await expect(deleteRecruitingCandidateNote(prisma, alice, note.id, NOW)).resolves.toEqual({
      ok: true,
    });
    expect(rows[0]?.deletedAt).toEqual(NOW);
    expect(
      (await listRecruitingCandidateNotes(prisma, alice, { candidateKeys: ["crm:42"] })).items,
    ).toEqual([]);
    await expect(
      updateRecruitingCandidateNote(prisma, alice, { id: note.id, body: "z" }),
    ).rejects.toThrow(IsolationError);
    await expect(deleteRecruitingCandidateNote(prisma, alice, note.id)).rejects.toThrow(
      IsolationError,
    );
  });

  it("isolates owners and foreign roles", async () => {
    const { prisma, rows } = fake();
    const note = await createRecruitingCandidateNote(prisma, alice, {
      candidateKey: "crm:42",
      body: "mine",
    });
    expect(
      (await listRecruitingCandidateNotes(prisma, bob, { candidateKeys: ["crm:42"] })).items,
    ).toEqual([]);
    await expect(
      updateRecruitingCandidateNote(prisma, bob, { id: note.id, body: "z" }),
    ).rejects.toThrow(IsolationError);
    await expect(deleteRecruitingCandidateNote(prisma, bob, note.id)).rejects.toThrow(
      IsolationError,
    );
    await expect(
      createRecruitingCandidateNote(prisma, bob, {
        candidateKey: "crm:42",
        body: "t",
        roleId: "role",
      }),
    ).rejects.toThrow(IsolationError);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "mine", deletedAt: null });
  });

  it("maps tool operations and tags the run's bot", async () => {
    const { prisma } = fake();
    const created = await executeRecruitingNotesTool(prisma, alice, "bot-1", {
      operation: "create",
      candidateKey: "autumn:k1",
      body: "Open to relocation",
    });
    expect(created).toMatchObject({ createdBy: "agent", authorName: "Sourcer" });
    const listed = await executeRecruitingNotesTool(prisma, alice, "bot-1", {
      operation: "list",
      candidateKeys: ["autumn:k1"],
    });
    expect(listed).toMatchObject({ items: [{ body: "Open to relocation" }] });
    const id = (created as { id: string }).id;
    expect(
      await executeRecruitingNotesTool(prisma, alice, "bot-1", {
        operation: "update",
        id,
        body: "Will relocate",
      }),
    ).toMatchObject({ body: "Will relocate" });
    expect(
      await executeRecruitingNotesTool(prisma, alice, "bot-1", { operation: "delete", id }),
    ).toEqual({ ok: true });
  });
});
