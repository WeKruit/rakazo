import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_PREWARM_CONCURRENCY,
  DISCOVERY_PREWARM_WINDOW_MS,
  prewarmToolDiscovery,
  warmBotDiscovery,
} from "./discovery-prewarm.js";

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

describe("prewarmToolDiscovery concurrency", () => {
  it("warms a few bots at a time instead of every bot at once", async () => {
    const bots = Array.from({ length: 20 }, (_, index) => ({
      botId: `bot-${index}`,
      spaceId: "space-1",
      userId: "user-1",
    }));
    let inFlight = 0;
    let peak = 0;
    const discoverTools = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });

    await prewarmToolDiscovery(
      { run: { groupBy: vi.fn(async () => bots) } } as unknown as PrismaClient,
      { discoverTools },
      new AbortController().signal,
    );

    expect(discoverTools).toHaveBeenCalledTimes(20);
    expect(peak).toBe(DISCOVERY_PREWARM_CONCURRENCY);
  });
});

describe("warmBotDiscovery", () => {
  it("lists a new bot's tools as that bot, with scope from the bot row", async () => {
    const findFirst = vi.fn(async () => ({ id: "bot-1", spaceId: "space-1", userId: "user-1" }));
    const discoverTools = vi.fn(async () => []);

    await warmBotDiscovery(
      { bot: { findFirst } } as unknown as PrismaClient,
      { discoverTools },
      "bot-1",
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot-1", archivedAt: null } }),
    );
    expect(discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
    );
  });

  it("does nothing for an archived or missing bot", async () => {
    const discoverTools = vi.fn(async () => []);
    await warmBotDiscovery(
      { bot: { findFirst: vi.fn(async () => null) } } as unknown as PrismaClient,
      { discoverTools },
      "gone",
    );
    expect(discoverTools).not.toHaveBeenCalled();
  });
});
