import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DISCOVERY_PREWARM_WINDOW_MS, prewarmToolDiscovery } from "./discovery-prewarm.js";

describe("prewarmToolDiscovery", () => {
  it("discovers each recently active bot's tools as that bot, without a run", async () => {
    const groupBy = vi.fn(async () => [
      { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
      { botId: "bot-2", spaceId: "space-2", userId: "user-2" },
    ]);
    const discoverTools = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("server down"));
    const now = Date.parse("2026-10-26T10:00:00Z");

    await prewarmToolDiscovery(
      { run: { groupBy } } as unknown as PrismaClient,
      { discoverTools },
      new AbortController().signal,
      now,
    );

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["botId", "spaceId", "userId"],
        where: { createdAt: { gte: new Date(now - DISCOVERY_PREWARM_WINDOW_MS) } },
      }),
    );
    expect(discoverTools.mock.calls.map(([context]) => context)).toEqual([
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
      expect.objectContaining({ botId: "bot-2", spaceId: "space-2", userId: "user-2" }),
    ]);
    expect(discoverTools.mock.calls[0]?.[0]).not.toHaveProperty("runId");
  });
});
