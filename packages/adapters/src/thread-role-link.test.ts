import { describe, expect, it, vi } from "vitest";
import { linkSavedThreadRole } from "./thread-role-link.js";

const prismaWith = (roleId: string | null) => ({
  thread: { findUnique: vi.fn(async () => ({ activeRecruitingRoleId: roleId })) },
});

describe("linkSavedThreadRole", () => {
  it("gives a run's thread the role its own save linked", async () => {
    const prisma = prismaWith("role-1");
    const thread = { id: "t", groupId: "g", activeRecruitingRoleId: null as string | null };
    await linkSavedThreadRole(prisma as never, thread, "recruiting_research");
    expect(thread.activeRecruitingRoleId).toBe("role-1");
  });

  it("reads nothing for a thread that has a role, other tools, or the global conversation", async () => {
    const prisma = prismaWith("role-2");
    await linkSavedThreadRole(
      prisma as never,
      { id: "t", groupId: "g", activeRecruitingRoleId: "role-1" },
      "recruiting_research",
    );
    await linkSavedThreadRole(
      prisma as never,
      { id: "t", groupId: "g", activeRecruitingRoleId: null },
      "web_fetch",
    );
    await linkSavedThreadRole(
      prisma as never,
      { id: "t", groupId: "recruiting-global-x", activeRecruitingRoleId: null },
      "recruiting_candidates",
    );
    expect(prisma.thread.findUnique).not.toHaveBeenCalled();
  });
});
