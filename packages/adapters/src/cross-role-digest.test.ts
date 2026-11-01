import { describe, expect, it, vi } from "vitest";
import { loadCrossRoleDigest } from "./cross-role-digest.js";

const now = Date.parse("2026-11-01T04:00:00Z");

function fakePrisma(groups: unknown[], messagesByThread: Record<string, unknown[]>) {
  return {
    chatGroup: { findMany: vi.fn(async () => groups) },
    recruitingRole: {
      findMany: vi.fn(async () => [
        {
          id: "role-1",
          title: "Agent Engineer",
          playbookStage: "calibration_10",
          _count: { candidates: 12 },
        },
      ]),
    },
    message: {
      findMany: vi.fn(
        async ({ where }: { where: { threadId: string } }) =>
          messagesByThread[where.threadId] ?? [],
      ),
    },
    bot: { findMany: vi.fn(async () => [{ id: "bot-sourcer", name: "Sourcer" }]) },
  };
}

describe("loadCrossRoleDigest", () => {
  it("summarizes each role team's latest work and open question, newest message last", async () => {
    const prisma = fakePrisma(
      [
        {
          id: "g1",
          name: "Recruiting",
          updatedAt: new Date(now - 2 * 3_600_000),
          thread: { id: "t1", activeRecruitingRoleId: "role-1" },
        },
        {
          id: "g2",
          name: "Data Scientist",
          updatedAt: new Date(now - 5 * 60_000),
          thread: { id: "t2", activeRecruitingRoleId: null },
        },
      ],
      {
        // Newest first, as read.
        t1: [
          {
            role: "bot",
            botId: "bot-sourcer",
            blocks: [{ kind: "ask", text: "Is USC required?", status: "pending" }],
          },
          {
            role: "user",
            botId: null,
            blocks: [{ kind: "text", text: "new grads,\n USC preferred" }],
          },
        ],
      },
    );
    const digest = await loadCrossRoleDigest(
      prisma as never,
      { spaceId: "s", userId: "u" },
      (text) => text.replace("secret", "[redacted]"),
      now,
    );
    expect(digest).toContain(
      "- Agent Engineer · roleId role-1 · stage calibration_10 · 12 people saved · last activity 2 h ago",
    );
    expect(digest).toContain('  Waiting on the recruiter: "Is USC required?"');
    expect(digest).toContain(
      'Recent: Recruiter: "new grads, USC preferred" / Sourcer: "Is USC required?"',
    );
    expect(digest).toContain("- Data Scientist · groupId g2, no saved role yet · last activity 5 min ago");
    expect(prisma.chatGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "s", userId: "u", archivedAt: null }),
      }),
    );
  });

  it("returns nothing when the recruiter has no role teams", async () => {
    expect(
      await loadCrossRoleDigest(
        fakePrisma([], {}) as never,
        { spaceId: "s", userId: "u" },
        (t) => t,
      ),
    ).toBeUndefined();
  });
});
