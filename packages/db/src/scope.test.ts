import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(found: boolean) {
  return {
    $queryRaw: vi.fn(async (query: Prisma.Sql) =>
      found
        ? [
            {
              userId: query.values[1],
              spaceId: query.values[2] ?? "space-default",
              email: "owner@example.test",
              isDeploymentOwner: true,
            },
          ]
        : [],
    ),
  } as unknown as PrismaClient;
}

describe("requireMembership", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-test", level: "off", sinks: [] }));
  });

  it("records each lookup separately in the existing request context", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    const prisma = prismaForMembership(true);

    await runWithLogContext({ "trace.id": "trace-test", "rpc.procedure": "me" }, async () => {
      await requireMembership(prisma, "user-1", "space-support");
      await requireMembership(prisma, "user-1", "space-support");
    });

    expect(sink.events).toHaveLength(2);
    for (const event of sink.events) {
      expect(event).toMatchObject({
        message: "membership.lookup.timing",
        "trace.id": "trace-test",
        "rpc.procedure": "me",
        queryMs: expect.any(Number),
        totalMs: expect.any(Number),
        outcome: "ok",
      });
      expect(event).not.toHaveProperty("email");
      expect(event).not.toHaveProperty("userId");
      expect(event).not.toHaveProperty("requestedSpaceId");
    }
  });

  it("rejects a missing membership after one joined lookup", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    const prisma = prismaForMembership(false);

    await expect(requireMembership(prisma, "user-1", "space-foreign")).rejects.toBeInstanceOf(
      IsolationError,
    );

    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "membership.lookup.timing",
      queryMs: expect.any(Number),
      totalMs: expect.any(Number),
      outcome: "missing",
    });
    expect(sink.events[0]).not.toHaveProperty("settingsMs");
  });

  it("records a failed joined lookup and preserves the original error object", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    const prisma = prismaForMembership(true);
    const failure = new Error("database unavailable");
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(failure);

    await expect(requireMembership(prisma, "user-1", "space-support")).rejects.toBe(failure);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "membership.lookup.timing",
      queryMs: expect.any(Number),
      totalMs: expect.any(Number),
      outcome: "error",
    });
    expect(sink.events[0]).not.toHaveProperty("settingsMs");
    expect(sink.events[0]).not.toHaveProperty("error");
  });

  it("scopes the actor to an explicitly requested space", async () => {
    const prisma = prismaForMembership(true);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toEqual({
      userId: "user-1",
      spaceId: "space-support",
      email: "owner@example.test",
      isDeploymentOwner: true,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    const query = vi.mocked(prisma.$queryRaw).mock.calls[0]![0] as Prisma.Sql;
    expect(query.values).toEqual(["default", "user-1", "space-support"]);
    expect(query.sql).toContain('WHERE sm."userId" = ?');
    expect(query.sql).toContain('AND sm."spaceId" = ?');
    expect(query.sql).toContain('s.id = sm."spaceId"');
    expect(query.sql).toContain('s."organizationId" = sm."organizationId"');
    expect(query.sql).toContain('m."organizationId" = sm."organizationId"');
    expect(query.sql).toContain('m."userId" = sm."userId"');
    expect(query.sql).toContain('u.id = m."userId"');
    expect(query.sql).toContain("LEFT JOIN deployment_settings settings ON settings.id = ?");
    expect(query.sql).toContain('COALESCE(settings."ownerUserId" = sm."userId", false)');
  });

  it("rejects a requested space the user does not belong to", async () => {
    await expect(
      requireMembership(prismaForMembership(false), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it.each([undefined, null, ""])(
    "keeps default-space ordering for a falsy requested space (%s)",
    async (requestedSpaceId) => {
      const prisma = prismaForMembership(true);
      await requireMembership(prisma, "user-1", requestedSpaceId);
      const query = vi.mocked(prisma.$queryRaw).mock.calls[0]![0] as Prisma.Sql;
      expect(query.values).toEqual(["default", "user-1"]);
      expect(query.sql).not.toContain('AND sm."spaceId" = ?');
      expect(query.sql.replace(/\s+/g, " ")).toContain(
        'ORDER BY s."isDefault" DESC, sm."createdAt" ASC, sm.id ASC LIMIT 1',
      );
    },
  );
});
