import { describe, expect, it, vi } from "vitest";
import { globalRoleWriteRefusal } from "./global-role-writes.js";

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
