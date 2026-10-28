import { describe, expect, it, vi } from "vitest";
import type { RunContextSnapshot } from "./run-context-notice.js";
import { createRunContextWatch, readRunContextSnapshot } from "./run-context-notice.js";

type Entries = Partial<Record<keyof RunContextSnapshot, Array<[string, string, string?]>>>;

function snapshot(entries: Entries): RunContextSnapshot {
  const map = (rows: Array<[string, string, string?]> = []) =>
    new Map(rows.map(([id, name, version = "1"]) => [id, { name, version }]));
  return { memory: map(entries.memory), skills: map(entries.skills), tools: map(entries.tools) };
}

const start = snapshot({
  memory: [["user: preferences.md", "user: preferences.md", "3"]],
  skills: [["s1", "outreach", "a"]],
  tools: [["connection:c1", "Gmail"]],
});

describe("run context watch", () => {
  it("names nothing when nothing changed", async () => {
    const watch = createRunContextWatch(async () => start, Promise.resolve(start));
    expect(await watch.claimNotice()).toBeUndefined();
  });

  it("names changed memory, skills and new tools once", async () => {
    const read = vi.fn(async () =>
      snapshot({
        memory: [
          ["user: preferences.md", "user: preferences.md", "4"],
          ["bot: MEMORY.md", "bot: MEMORY.md", "1"],
        ],
        skills: [
          ["s1", "outreach", "a"],
          ["s2", "screening", "b"],
        ],
        tools: [
          ["connection:c1", "Gmail"],
          ["mcp:m1", "Calendar"],
        ],
      }),
    );
    const watch = createRunContextWatch(read, Promise.resolve(start));

    expect(await watch.claimNotice()).toBe(
      [
        "Memory changed: bot: MEMORY.md, user: preferences.md; read_memory for details.",
        "Skills changed: screening; skill_read for details.",
        "New tools available: Calendar (callable from the next run).",
      ].join("\n"),
    );
    // The same state is not announced again at the following boundary.
    expect(await watch.claimNotice()).toBeUndefined();
  });

  it("names removed tools and memory", async () => {
    const watch = createRunContextWatch(
      async () => snapshot({ skills: [["s1", "outreach", "a"]] }),
      Promise.resolve(start),
    );
    expect(await watch.claimNotice()).toBe(
      [
        "Memory changed: user: preferences.md; read_memory for details.",
        "Tools changed or removed: Gmail (from the next run).",
      ].join("\n"),
    );
  });

  it("adopts the run's own writes without a notice", async () => {
    const watch = createRunContextWatch(
      async () =>
        snapshot({
          memory: [["user: preferences.md", "user: preferences.md", "4"]],
          skills: [["s1", "outreach", "b"]],
          tools: [["connection:c1", "Gmail"]],
        }),
      Promise.resolve(start),
    );
    watch.acknowledge("memory", "user: preferences.md");
    watch.acknowledge("skills");
    expect(await watch.claimNotice()).toBeUndefined();
  });

  it("stays quiet when the snapshot cannot be read", async () => {
    const failing = createRunContextWatch(async () => start, Promise.reject(new Error("db")));
    expect(await failing.claimNotice()).toBeUndefined();
    const unreadable = createRunContextWatch(async () => {
      throw new Error("db");
    }, Promise.resolve(start));
    expect(await unreadable.claimNotice()).toBeUndefined();
  });

  it("keeps names to one short redacted line", async () => {
    const tools = Array.from(
      { length: 10 },
      (_, index) => [`install:${index}`, `Tool ${index}\nsecret-key`] as [string, string],
    );
    const watch = createRunContextWatch(
      async () => snapshot({ tools }),
      Promise.resolve(snapshot({})),
      (text) => text.replaceAll("secret-key", "[redacted]"),
    );
    expect(await watch.claimNotice()).toBe(
      `New tools available: ${Array.from({ length: 8 }, (_, index) => `Tool ${index} [redacted]`).join(", ")} and 2 more (callable from the next run).`,
    );
  });
});

describe("readRunContextSnapshot", () => {
  it("reads only names and versions scoped to the run's owner and bot", async () => {
    const updatedAt = new Date("2026-10-01T00:00:00.000Z");
    const prisma = {
      memoryDocument: {
        findMany: vi.fn(async () => [{ scope: "user", path: "preferences.md", revision: 2 }]),
      },
      agentSkill: { findMany: vi.fn(async () => [{ id: "s1", name: "outreach", updatedAt }]) },
      botMcpServer: {
        findMany: vi.fn(async () => [
          { id: "a1", updatedAt, server: { name: "Calendar", revision: 3 } },
        ]),
      },
      connection: { findMany: vi.fn(async () => [{ id: "c1", displayName: "Gmail" }]) },
      capabilityInstall: { findMany: vi.fn(async () => [{ id: "i1", name: "CRM API" }]) },
    };
    const owner = { spaceId: "space", userId: "user", botId: "bot" };

    const read = await readRunContextSnapshot(prisma as never, owner);

    expect(prisma.memoryDocument.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        userId: "user",
        OR: [{ scope: "user" }, { scope: "bot", botId: "bot" }],
      },
      select: { scope: true, path: true, revision: true },
    });
    expect(prisma.botMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "bot", spaceId: "space", userId: "user", server: { enabled: true } },
      }),
    );
    expect(prisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "space", userId: "user", status: "connected" } }),
    );
    expect([...read.memory.values()]).toEqual([{ name: "user: preferences.md", version: "2" }]);
    expect([...read.skills.values()]).toEqual([
      { name: "outreach", version: updatedAt.toISOString() },
    ]);
    expect([...read.tools.values()].map((entry) => entry.name)).toEqual([
      "Calendar",
      "Gmail",
      "CRM API",
    ]);
  });
});
