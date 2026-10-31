import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { backfillRecruitingCrews } from "./recruiting-bootstrap.js";

describe("backfillRecruitingCrews", () => {
  it("covers crews set up before recruiting spawn keys", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      bot: { findMany },
      user: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    await backfillRecruitingCrews(prisma, { sandboxKind: "local" }, () => undefined);
    const where = (findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }])[0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { spawnKey: { startsWith: "recruiting:", endsWith: ":main" } },
        expect.objectContaining({ name: "Main" }),
      ]),
    );
  });
});
