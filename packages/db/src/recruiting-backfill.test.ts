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
      deploymentSettings: { findUnique: vi.fn(async () => null), updateMany: vi.fn() },
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

  it("resumes after the account it reached and skips a finished walk", async () => {
    const owner = (id: string) => ({
      userId: id,
      spaceId: `space-${id}`,
      space: {
        createdByUserId: id,
        memberships: [{ userId: id }],
        organization: { members: [{ userId: id }] },
      },
    });
    const ids = ["a", "b", "c"];
    const findMany = vi.fn(async () => ids.map(owner));
    let settings = {
      recruitingBackfillKey: null as string | null,
      recruitingBackfillCursor: null as string | null,
    };
    const shutdown = new AbortController();
    const visited: string[] = [];
    const prisma = {
      spaceMember: { findMany },
      user: { findMany: vi.fn(async () => ids.map((id) => ({ id, email: `${id}@example.test` }))) },
      capabilityInstall: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
          visited.push(where.userId);
          if (where.userId === "a") shutdown.abort();
          throw new Error("account reached");
        }),
      },
      deploymentSettings: {
        findUnique: vi.fn(async () => settings),
        updateMany: vi.fn(async ({ data }: { data: typeof settings }) => {
          settings = data;
        }),
      },
    } as unknown as PrismaClient;
    const options = { sandboxKind: "local", signal: shutdown.signal };
    await backfillRecruitingCrews(prisma, options, () => undefined);
    expect(visited).toEqual(["a"]);
    await backfillRecruitingCrews(prisma, { sandboxKind: "local" }, () => undefined);
    expect(visited).toEqual(["a", "b", "c"]);
    expect(settings.recruitingBackfillCursor).toBeNull();
    findMany.mockClear();
    await backfillRecruitingCrews(prisma, { sandboxKind: "local" }, () => undefined);
    expect(findMany).not.toHaveBeenCalled();
    expect(visited).toHaveLength(3);
  });
});
