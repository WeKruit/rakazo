import { createRouterClient } from "@orpc/server";
import { CreateRoutineInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "a@example.test",
  isDeploymentOwner: false,
};
function fixture(thread: unknown = { id: "group-thread" }) {
  const row = {
    id: "routine",
    botId: "main",
    threadId: "group-thread",
    name: "Interview digest",
    prompt: "List interviews",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-10-30T12:00:00Z"),
  };
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "main", thread: { id: "dm-thread" } }) },
    thread: { findFirst: vi.fn().mockResolvedValue(thread) },
    routine: { create: vi.fn().mockResolvedValue(row), findMany: vi.fn().mockResolvedValue([row]) },
  };
  const deps = {
    prisma,
    env: {},
    events: { append: vi.fn() },
    jobs: { enqueue: vi.fn() },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  return { prisma, client, row };
}
describe("recruiting routine targets", () => {
  it("keeps the existing native thread target in create and list inputs", () => {
    expect(
      CreateRoutineInput.parse({
        botId: "main",
        threadId: "group-thread",
        name: "Digest",
        prompt: "List interviews",
        crons: ["0 9 * * *"],
      }),
    ).toHaveProperty("threadId", "group-thread");
  });
  it("creates a routine in the owned crew thread and exposes its target", async () => {
    const f = fixture();
    const result = await f.client.routines.create({
      botId: "main",
      threadId: "group-thread",
      name: "Digest",
      prompt: "List interviews",
      crons: ["0 9 * * *"],
    });
    expect(f.prisma.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "group-thread",
          userId: actor.userId,
          spaceId: actor.spaceId,
          group: expect.objectContaining({ members: { some: { botId: "main" } } }),
        }),
      }),
    );
    expect(f.prisma.routine.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread" }) }),
    );
    expect(result.threadId).toBe("group-thread");
  });
  it("rejects a foreign target before saving anything", async () => {
    const f = fixture(null);
    await expect(
      f.client.routines.create({
        botId: "main",
        threadId: "foreign",
        name: "Digest",
        prompt: "List interviews",
        crons: ["0 9 * * *"],
      }),
    ).rejects.toThrow();
    expect(f.prisma.routine.create).not.toHaveBeenCalled();
  });
  it("filters the list by the caller and crew target", async () => {
    const f = fixture();
    await f.client.routines.list({ botId: "main", threadId: "group-thread" });
    expect(f.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: "main",
          userId: actor.userId,
          spaceId: actor.spaceId,
          threadId: "group-thread",
        },
      }),
    );
  });
  it("lists routines from different owned crews in one account read without personal or archived threads", async () => {
    const f = fixture();
    f.prisma.routine.findMany.mockResolvedValue([
      f.row,
      { ...f.row, id: "second-routine", botId: "second-main", threadId: "second-role-thread" },
    ]);
    const result = await f.client.routines.list({ botId: "main", allConversations: true });
    expect(result.map((item) => item.botId)).toEqual(["main", "second-main"]);
    expect(f.prisma.routine.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
          thread: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            group: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
          },
        },
      }),
    );
  });
  it("does not combine an account routine list with a different crew target", async () => {
    const f = fixture();
    await expect(
      f.client.routines.list({ botId: "main", allConversations: true, threadId: "other-thread" }),
    ).rejects.toThrow();
    expect(f.prisma.routine.findMany).not.toHaveBeenCalled();
  });
});
