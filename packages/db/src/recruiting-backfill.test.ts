import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { backfillRecruitingCrews } from "./recruiting-bootstrap.js";

describe("backfillRecruitingCrews", () => {
  it("reaches private accounts without requiring recruiting spawn keys", async () => {
    const findMany = vi.fn(async () => [
      {
        userId: "legacy-owner",
        spaceId: "private-space",
        space: {
          createdByUserId: "legacy-owner",
          memberships: [{ userId: "legacy-owner" }],
          organization: { members: [{ userId: "legacy-owner" }] },
        },
      },
    ]);
    const visited = new Error("account reached");
    const findFirst = vi.fn(async () => {
      throw visited;
    });
    const onError = vi.fn();
    const prisma = {
      spaceMember: { findMany },
      user: { findMany: vi.fn(async () => [{ id: "legacy-owner", email: "legacy@example.test" }]) },
      capabilityInstall: { findFirst },
    } as unknown as PrismaClient;
    await backfillRecruitingCrews(prisma, { sandboxKind: "local" }, onError);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "owner", space: { isDefault: true, deletingAt: null } },
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "legacy-owner", spaceId: "private-space" }),
      }),
    );
    expect(onError).toHaveBeenCalledWith(visited);
  });
});
