import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requestConnection } from "./request-connection.js";

const scope = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };
const args = { serverId: "server-1", reason: "To read candidate replies." };

function fixture({
  secretId = null as string | null,
  assigned = true,
  pendingRun = undefined as string | undefined,
} = {}) {
  const prisma = {
    mcpServer: {
      findFirst: vi.fn(async () => ({
        id: "server-1",
        name: "Instantly",
        secretId,
        transport: "streamable_http",
      })),
    },
    botMcpServer: { findFirst: vi.fn(async () => (assigned ? { id: "assignment" } : null)) },
    message: {
      findMany: vi.fn(async () =>
        pendingRun
          ? [
              {
                id: "ask-1",
                runId: pendingRun,
                blocks: [
                  {
                    kind: "ask",
                    text: "Connect Instantly",
                    status: "pending",
                    connection: { serverId: "server-1", name: "Instantly", reason: "x" },
                  },
                ],
              },
            ]
          : [],
      ),
    },
    run: { findMany: vi.fn(async () => (pendingRun ? [{ id: pendingRun }] : [])) },
  };
  return { prisma, db: prisma as unknown as PrismaClient, pause: vi.fn(async () => {}) };
}

describe("request_connection", () => {
  it("returns connected without a card when credentialed and assigned to this bot", async () => {
    const f = fixture({ secretId: "secret-1" });
    expect(await requestConnection(f.db, scope, args, f.pause)).toEqual({ status: "connected" });
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "server-1", spaceId: "space-1", userId: "user-1", enabled: true },
      }),
    );
  });

  it("pauses on one native connect card when not connected", async () => {
    const f = fixture();
    expect(await requestConnection(f.db, scope, args, f.pause)).toBeUndefined();
    expect(f.pause).toHaveBeenCalledWith({
      kind: "ask",
      text: "Connect Instantly",
      status: "pending",
      connection: { serverId: "server-1", name: "Instantly", reason: "To read candidate replies." },
    });
  });

  it("returns the pending ask instead of opening a second card for the same server", async () => {
    const f = fixture({ pendingRun: "run-0" });
    expect(await requestConnection(f.db, scope, args, f.pause)).toEqual({
      status: "pending",
      askId: "ask-1",
    });
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("refuses an unassigned server and a missing reason without a card", async () => {
    const unassigned = fixture({ secretId: "secret-1", assigned: false });
    expect(await requestConnection(unassigned.db, scope, args, unassigned.pause)).toHaveProperty(
      "error",
    );
    const noReason = fixture();
    expect(
      await requestConnection(noReason.db, scope, { serverId: "server-1" }, noReason.pause),
    ).toHaveProperty("error");
    expect(unassigned.pause).not.toHaveBeenCalled();
    expect(noReason.pause).not.toHaveBeenCalled();
  });
});
