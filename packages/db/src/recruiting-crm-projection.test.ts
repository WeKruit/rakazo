import { describe, expect, it, vi } from "vitest";
import { listSyncedRecruitingCrmRoleContacts } from "./recruiting-crm-sync.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const source = { mcpServerId: "source", organizationId: "organization" };
describe("CRM projection coverage", () => {
  it.each([false, true])(
    "distinguishes absent role metadata from an empty synced projection (%s)",
    async (synced) => {
      const findFirst = vi.fn(async () => (synced ? { id: "role" } : null));
      const findMany = vi.fn(async () => []);
      const prisma = { recruitingCrmRole: { findFirst }, recruitingCrmRoleContact: { findMany } };
      expect(
        await listSyncedRecruitingCrmRoleContacts(prisma as never, actor, source, "crm-role"),
      ).toEqual(synced ? [] : null);
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          ...source,
          crmRoleId: "crm-role",
          archivedAt: null,
        },
        select: { id: true },
      });
      expect(findMany).toHaveBeenCalledTimes(synced ? 1 : 0);
    },
  );
});
