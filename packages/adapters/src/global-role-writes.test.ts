import { describe, expect, it, vi } from "vitest";
import {
  globalRoleWriteRefusal,
  otherRoleWriteRefusal,
  roleRequestMessage,
} from "./global-role-writes.js";

function prisma(boundRoleId?: string, openRun?: { status: string }) {
  return {
    externalEffect: {
      findFirst: vi.fn(async () => (boundRoleId ? { request: { roleId: boundRoleId } } : null)),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "role-1" ? { id: "role-1", title: "Senior Data Engineer — Seattle" } : null,
      ),
    },
    run: { findFirst: vi.fn(async () => openRun ?? null) },
  };
}
const actor = { spaceId: "s", userId: "u", threadId: "global" };

describe("globalRoleWriteRefusal", () => {
  it("leaves a role's campaign to its conversation while that has a run open (staging 11-14)", async () => {
    // Global Kruit paused a role's confirmed send and rewrote its email while the role's own
    // team was fixing the same campaign.
    for (const status of ["running", "waiting_input"]) {
      const db = prisma("role-1", { status });
      const error = await globalRoleWriteRefusal(db as never, actor, {
        toolName: "native_instantly_pause_campaign",
        args: { campaign_id: "c-1" },
      });
      expect(error).toContain('delegate_to_role, role_id "role-1"');
      expect(db.run.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            threadId: { not: "global" },
            thread: { activeRecruitingRoleId: "role-1" },
          }),
        }),
      );
    }
  });

  it("lets Kruit change a role's campaign itself when no other conversation is on it", async () => {
    expect(
      await globalRoleWriteRefusal(prisma() as never, actor, {
        toolName: "native_instantly_ensure_role_campaign",
        args: { role_id: "role-1", steps: [] },
      }),
    ).toBeUndefined();
  });

  it("never checks reads, one-off campaigns or account setup", async () => {
    for (const [toolName, args] of [
      ["native_instantly_get_campaign", { campaign_id: "c-1" }],
      ["native_instantly_activate_campaign", { campaign_id: "one-off" }],
      ["native_instantly_ensure_sender", {}],
    ] as const) {
      const bound = toolName === "native_instantly_get_campaign" ? "role-1" : undefined;
      expect(
        await globalRoleWriteRefusal(prisma(bound, { status: "running" }) as never, actor, {
          toolName,
          args,
        }),
      ).toBeUndefined();
    }
  });
});

describe("otherRoleWriteRefusal", () => {
  it("keeps a role's conversation to its own role's campaigns (stop-after-approve, 11-20)", async () => {
    // "全停掉" in one role's conversation also paused two other roles' campaigns.
    const error = await otherRoleWriteRefusal(prisma("role-1") as never, actor, "role-2", {
      toolName: "native_instantly_pause_campaign",
      args: { campaign_id: "c-1" },
    });
    expect(error).toContain("Senior Data Engineer — Seattle");
    expect(
      await otherRoleWriteRefusal(prisma("role-1") as never, actor, "role-1", {
        toolName: "native_instantly_pause_campaign",
        args: { campaign_id: "c-1" },
      }),
    ).toBeUndefined();
    expect(
      await otherRoleWriteRefusal(prisma() as never, actor, "role-2", {
        toolName: "native_instantly_pause_campaign",
        args: { campaign_id: "one-off" },
      }),
    ).toBeUndefined();
  });
});

describe("roleRequestMessage", () => {
  const rounds = (round: { approvedAt: Date | null } | null) => ({
    recruitingCalibrationRound: { findFirst: vi.fn(async () => round) },
  });
  const words = "3 and 10 aren't a fit, find more like the rest";

  it("sends feedback on an open round as the recruiter's own words (staging 11-15)", async () => {
    // Kruit's brief turned "find more like the rest" into "find the next 20 people", so the team
    // scaled out and round 2 was never built.
    const message = await roleRequestMessage(rounds({ approvedAt: null }) as never, {
      roleId: "role-1",
      recruiterWords: words,
      brief: "Goal: find the next 20 people",
    });
    expect(message).toContain(`"${words}"`);
    expect(message).toMatch(/never a number of people or a scale-out/);
  });

  it("keeps who the recruiter means while a round waits on them (team-has-no-email 11-16)", async () => {
    // Kruit's brief named Bhargav; only 「没存的话现在怎么办？」 reached the team, which took
    // "him" to be the person its own conversation last talked about.
    const message = await roleRequestMessage(rounds({ approvedAt: null }) as never, {
      roleId: "role-1",
      recruiterWords: "没存的话现在怎么办？",
      brief: "Candidate Bhargav P: is his email saved?",
    });
    expect(message.indexOf("没存的话")).toBeLessThan(message.indexOf("Bhargav P"));
  });

  it("puts the recruiter's words before Kruit's brief once no round waits on them", async () => {
    for (const round of [null, { approvedAt: new Date() }]) {
      const message = await roleRequestMessage(rounds(round) as never, {
        roleId: "role-1",
        recruiterWords: "find 20 more",
        brief: "Goal: 20 more people",
      });
      expect(message.indexOf('"find 20 more"')).toBeLessThan(message.indexOf("Goal: 20 more"));
    }
  });

  it("keeps the brief alone when no recruiter message started this turn", async () => {
    const message = await roleRequestMessage(rounds({ approvedAt: null }) as never, {
      roleId: "role-1",
      recruiterWords: "",
      brief: "Goal: use Ana's profile from the other role",
    });
    expect(message).toBe("Goal: use Ana's profile from the other role");
  });
});
