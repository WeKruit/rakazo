import { describe, expect, it, vi } from "vitest";
import {
  globalPeopleSearchRefusal,
  globalRoleWriteRefusal,
  roleRequestMessage,
} from "./global-role-writes.js";

function prisma(boundRoleId?: string) {
  return {
    externalEffect: {
      findFirst: vi.fn(async () => (boundRoleId ? { request: { roleId: boundRoleId } } : null)),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "role-1" ? { id: "role-1", title: "Senior Data Engineer — Seattle" } : null,
      ),
    },
  };
}
const actor = { spaceId: "s", userId: "u" };

describe("globalRoleWriteRefusal", () => {
  it("sends a write to a role's campaign to that role's team (staging 11-14)", async () => {
    // Global Kruit paused a role's confirmed send and rewrote its email while the role's own
    // team was fixing the same campaign.
    const error = await globalRoleWriteRefusal(prisma("role-1") as never, actor, {
      toolName: "native_instantly_pause_campaign",
      args: { campaign_id: "c-1" },
    });
    expect(error).toContain('delegate_to_role, role_id "role-1"');
    expect(error).toContain("Senior Data Engineer — Seattle");
  });

  it("refuses a role_id write the same way", async () => {
    const error = await globalRoleWriteRefusal(prisma() as never, actor, {
      toolName: "native_instantly_ensure_role_campaign",
      args: { role_id: "role-1", steps: [] },
    });
    expect(error).toContain('role_id "role-1"');
  });

  it("leaves reads, one-off campaigns and account setup to Kruit", async () => {
    for (const [toolName, args] of [
      ["native_instantly_get_campaign", { campaign_id: "c-1" }],
      ["native_instantly_activate_campaign", { campaign_id: "one-off" }],
      ["native_instantly_ensure_sender", {}],
    ] as const) {
      const bound = toolName === "native_instantly_get_campaign" ? "role-1" : undefined;
      expect(
        await globalRoleWriteRefusal(prisma(bound) as never, actor, { toolName, args }),
      ).toBeUndefined();
    }
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
    expect(message).not.toContain("next 20");
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

describe("globalPeopleSearchRefusal", () => {
  // Staging 11-15: asked "show me people", Kruit's own chat ran people searches and hand-wrote four
  // lists before any role existed, so nothing was saved, checked or kept out of the next round.
  it("sends a people search to a role's team, but lets a profile lookup through", () => {
    for (const toolName of ["web_search_exa", "web_search_advanced_exa", "agent_run"])
      expect(
        globalPeopleSearchRefusal(toolName, { query: "Senior Data Engineer Seattle Spark" }),
      ).toContain("start_role");
    expect(
      globalPeopleSearchRefusal("web_search_exa", {
        query: "https://www.linkedin.com/in/joelazose",
      }),
    ).toBeUndefined();
    expect(globalPeopleSearchRefusal("crm_list", {})).toBeUndefined();
  });
});
