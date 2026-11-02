import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

const savedPage = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  readSavedRecruitingSequences: savedPage,
}));

import { readRecruitingAccountView } from "./recruiting-account.js";

it("reads one saved campaign page without a role/provider fanout and rechecks authorization", async () => {
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const page = { roles: [], items: [], total: 61, nextCursor: "25" };
  savedPage.mockResolvedValue(page);
  const execute = vi.fn(() => {
    throw new Error("Provider reads must not run");
  });
  const stillAuthorized = vi.fn(async () => true);
  const prisma = {
    recruitingRole: {
      findMany: vi.fn(() => {
        throw new Error("Per-role read");
      }),
    },
  };
  const deps = {
    prisma: prisma as never,
    artifacts: {} as never,
    connectors: { execute } as never,
    stillAuthorized,
  };
  const input = { view: "sequence" as const, sequenceSummary: true, limit: 25, cursor: "25" };
  expect(await readRecruitingAccountView(deps, actor, input)).toEqual(page);
  expect(savedPage).toHaveBeenCalledExactlyOnceWith(prisma, actor, input);
  expect(execute).not.toHaveBeenCalled();
  expect(prisma.recruitingRole.findMany).not.toHaveBeenCalled();
  expect(stillAuthorized).toHaveBeenCalledTimes(2);
  stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(readRecruitingAccountView(deps, actor, input)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
