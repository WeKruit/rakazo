import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(found: boolean) {
  return {
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; spaceId?: string } }) =>
        found
          ? {
              userId: where.userId,
              spaceId: where.spaceId ?? "space-default",
              member: { user: { email: "owner@example.test" } },
            }
          : null,
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })),
    },
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
        membershipMs: expect.any(Number),
        settingsMs: expect.any(Number),
        totalMs: expect.any(Number),
        outcome: "ok",
      });
      expect(event).not.toHaveProperty("email");
      expect(event).not.toHaveProperty("userId");
      expect(event).not.toHaveProperty("requestedSpaceId");
    }
  });

  it("does not time or execute settings when membership is missing", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    const prisma = prismaForMembership(false);

    await expect(requireMembership(prisma, "user-1", "space-foreign")).rejects.toBeInstanceOf(
      IsolationError,
    );

    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "membership.lookup.timing",
      membershipMs: expect.any(Number),
      totalMs: expect.any(Number),
      outcome: "missing",
    });
    expect(sink.events[0]).not.toHaveProperty("settingsMs");
  });

  it.each(["membership", "settings"] as const)(
    "records a failed %s read and preserves the original error object",
    async (stage) => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
      const prisma = prismaForMembership(true);
      const failure = new Error("database unavailable");
      const failedRead =
        stage === "membership"
          ? prisma.spaceMember.findFirst
          : prisma.deploymentSettings.findUnique;
      vi.mocked(failedRead).mockRejectedValueOnce(failure);

      await expect(requireMembership(prisma, "user-1", "space-support")).rejects.toBe(failure);

      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        message: "membership.lookup.timing",
        membershipMs: expect.any(Number),
        totalMs: expect.any(Number),
        outcome: "error",
      });
      if (stage === "membership") {
        expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
        expect(sink.events[0]).not.toHaveProperty("settingsMs");
      } else {
        expect(sink.events[0]).toHaveProperty("settingsMs", expect.any(Number));
      }
      expect(sink.events[0]).not.toHaveProperty("error");
    },
  );

  it("scopes the actor to an explicitly requested space", async () => {
    const prisma = prismaForMembership(true);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toEqual({
      userId: "user-1",
      spaceId: "space-support",
      email: "owner@example.test",
      isDeploymentOwner: true,
    });
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", spaceId: "space-support" },
      }),
    );
  });

  it("rejects a requested space the user does not belong to", async () => {
    await expect(
      requireMembership(prismaForMembership(false), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("selects the explicit default Space before older non-default memberships", async () => {
    const prisma = prismaForMembership(true);

    await requireMembership(prisma, "user-1");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });
});
